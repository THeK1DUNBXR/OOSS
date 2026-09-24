/**
 * Compliance — books and audit (docs/plan/compliance.md, D).
 *
 * Seven tabs, one per thing this workstream built: accounting periods (the
 * two-party close), the audit hash chain (verify on demand), Schedule III
 * statements, depreciation (Schedule II against the Income-tax block), the
 * three exports, bank reconciliation, and retention. Nothing here claims to
 * file anything or delete a record past its floor — it flags, exports and
 * closes, and says so on screen where it does not do more.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, money } from '../../lib/api.js';
import { messageOf, TextInput } from '../../components/forms.js';
import { Card, EmptyState, ErrorBox, Loading, Metric, PageHeader, StatusChip, Tabs } from '../../components/ui.js';

type Tab = 'periods' | 'audit' | 'statements' | 'depreciation' | 'exports' | 'bank' | 'retention';

function thisMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function thisFyStartYear(): number {
  const d = new Date();
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return money(value);
}

interface AccountingPeriod {
  id: string;
  period: string;
  fy: string;
  status: string;
  requestedById: string | null;
  requestedAt: string | null;
  closedById: string | null;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
}

export function ComplianceBooks() {
  const [tab, setTab] = useState<Tab>('periods');

  return (
    <>
      <PageHeader
        title="Books and audit"
        subtitle="The audit trail, closed periods, Schedule III and II, exports, bank reconciliation and retention."
      />
      <Tabs
        tabs={[
          { key: 'periods', label: 'Periods' },
          { key: 'audit', label: 'Audit chain' },
          { key: 'statements', label: 'Statements' },
          { key: 'depreciation', label: 'Depreciation' },
          { key: 'exports', label: 'Exports' },
          { key: 'bank', label: 'Bank reconciliation' },
          { key: 'retention', label: 'Retention' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'periods' && <PeriodsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'statements' && <StatementsTab />}
      {tab === 'depreciation' && <DepreciationTab />}
      {tab === 'exports' && <ExportsTab />}
      {tab === 'bank' && <BankTab />}
      {tab === 'retention' && <RetentionTab />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

function PeriodsTab() {
  const qc = useQueryClient();
  const [period, setPeriod] = useState(thisMonth());
  const [reopenReason, setReopenReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ['cmp-books-periods'],
    queryFn: () => api.get<AccountingPeriod[]>('/compliance/books/periods'),
  });

  const requestClose = useMutation({
    mutationFn: () => api.post(`/compliance/books/periods/${period}/request-close`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['cmp-books-periods'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const close = useMutation({
    mutationFn: () => api.post(`/compliance/books/periods/${period}/close`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['cmp-books-periods'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });
  const reopen = useMutation({
    mutationFn: () => api.post(`/compliance/books/periods/${period}/reopen`, { reason: reopenReason }),
    onSuccess: () => {
      setError(null);
      setReopenReason('');
      qc.invalidateQueries({ queryKey: ['cmp-books-periods'] });
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Card
      title="Accounting periods"
      subtitle="A period closes in two steps by two different people — the proposer never approves. Independent of GST's own filing lock."
    >
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <TextInput label="Period" value={period} onChange={setPeriod} placeholder="YYYY-MM" />
        <button className="btn" disabled={requestClose.isPending} onClick={() => requestClose.mutate()}>
          Request close
        </button>
        <button className="btn" disabled={close.isPending} onClick={() => close.mutate()}>
          Close (approve)
        </button>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <TextInput label="Reopen reason" value={reopenReason} onChange={setReopenReason} placeholder="Why this closed period needs to reopen" />
        <button className="btn" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
          Reopen {period}
        </button>
      </div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {periods.isLoading && <Loading />}
      {periods.error && <ErrorBox error={periods.error} />}
      {periods.data && periods.data.length === 0 && (
        <EmptyState message="No period has been touched yet — every month is open until requested closed." />
      )}
      {periods.data && periods.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>FY</th>
              <th>Status</th>
              <th>Requested</th>
              <th>Closed</th>
              <th>Reopen reason</th>
            </tr>
          </thead>
          <tbody>
            {periods.data.map((p) => (
              <tr key={p.id}>
                <td>{p.period}</td>
                <td>{p.fy}</td>
                <td>
                  <StatusChip
                    status={p.status}
                    tone={p.status === 'closed' ? 'good' : p.status === 'closing' ? 'warn' : p.status === 'reopened' ? 'bad' : 'neutral'}
                  />
                </td>
                <td>{date(p.requestedAt)}</td>
                <td>{date(p.closedAt)}</td>
                <td>{p.reopenReason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit chain
// ---------------------------------------------------------------------------

interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
}

function AuditTab() {
  const verify = useMutation({
    mutationFn: () => api.get<VerifyResult>('/compliance/books/audit/verify'),
  });

  return (
    <Card title="Audit hash chain" subtitle="Every AuditRecord hashes its content and the previous record's hash, the way the event log already does.">
      <button className="btn-primary mb-4" disabled={verify.isPending} onClick={() => verify.mutate()}>
        {verify.isPending ? 'Verifying…' : 'Verify chain'}
      </button>
      {verify.error && <ErrorBox error={verify.error} />}
      {verify.data && (
        <div className="flex flex-wrap gap-6">
          <Metric
            label="Result"
            value={verify.data.ok ? 'Intact' : 'Broken'}
            tone={verify.data.ok ? 'good' : 'bad'}
            noActionReason="This status is informational; use the detailed verification output to investigate any issues."
          />
          <Metric
            label="Records checked"
            value={String(verify.data.checked)}
            noActionReason="This count is informational; review the audit log to understand the checked scope."
          />
          {!verify.data.ok && (
            <Metric
              label="Broken at"
              value={verify.data.brokenAt ?? '—'}
              tone="bad"
              noActionReason="Use the broken record detail to investigate and repair the hash chain."
            />
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Statements — Schedule III
// ---------------------------------------------------------------------------

interface ScheduleIIIStatement {
  fy: string;
  profitAndLoss: { heads: Array<{ head: string; amount: number }>; unmapped: Array<{ name: string; amount: number }>; income: number; expense: number; net: number };
  balanceSheet: { heads: Array<{ head: string; amount: number }>; unmapped: Array<{ name: string; amount: number }>; total: number };
}

function StatementsTab() {
  const [fy, setFy] = useState(String(thisFyStartYear()));
  const statement = useQuery({
    queryKey: ['cmp-books-statement', fy],
    queryFn: () => api.get<ScheduleIIIStatement>(`/compliance/books/statements/${fy}`),
    enabled: Boolean(fy),
  });

  return (
    <Card title="Schedule III statements" subtitle="The P&L and balance sheet in Schedule III's format. Unmapped items are listed, never dropped.">
      <div className="mb-4">
        <TextInput label="FY start year" value={fy} onChange={setFy} placeholder="2025 for FY2025-26" />
      </div>
      {statement.isLoading && <Loading />}
      {statement.error && <ErrorBox error={statement.error} />}
      {statement.data && (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink-200">Profit &amp; Loss — {statement.data.fy}</h3>
            <table className="table">
              <tbody>
                {statement.data.profitAndLoss.heads.map((h) => (
                  <tr key={h.head}>
                    <td>{h.head}</td>
                    <td className="text-right">{rupees(h.amount)}</td>
                  </tr>
                ))}
                {statement.data.profitAndLoss.unmapped.map((u) => (
                  <tr key={u.name}>
                    <td className="italic text-ink-500">{u.name} (not yet mapped)</td>
                    <td className="text-right italic text-ink-500">{rupees(u.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-ink-400">Net: {rupees(statement.data.profitAndLoss.net)}</p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink-200">Balance sheet</h3>
            <table className="table">
              <tbody>
                {statement.data.balanceSheet.heads.map((h) => (
                  <tr key={h.head}>
                    <td>{h.head}</td>
                    <td className="text-right">{rupees(h.amount)}</td>
                  </tr>
                ))}
                {statement.data.balanceSheet.unmapped.map((u) => (
                  <tr key={u.name}>
                    <td className="italic text-ink-500">{u.name} (not yet mapped)</td>
                    <td className="text-right italic text-ink-500">{rupees(u.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

interface DepreciationRow {
  id: string;
  recordCode: string;
  name: string;
  assetClass: string;
  cost: number;
  companiesAct: { usefulLifeYears?: number; charge?: number; mismatch?: boolean; assetUsefulLifeYears?: number; note?: string };
  incomeTax: { blockName?: string; ratePercent?: number; charge?: number | null; note?: string };
}

function DepreciationTab() {
  const [fy, setFy] = useState(String(thisFyStartYear()));
  const report = useQuery({
    queryKey: ['cmp-books-depreciation', fy],
    queryFn: () => api.get<{ fy: string; rows: DepreciationRow[] }>(`/compliance/books/depreciation/${fy}`),
    enabled: Boolean(fy),
  });

  return (
    <Card title="Depreciation" subtitle="Schedule II (Companies Act) against the Income-tax Act's block WDV — two different questions, so two different answers.">
      <div className="mb-4">
        <TextInput label="FY start year" value={fy} onChange={setFy} placeholder="2025 for FY2025-26" />
      </div>
      {report.isLoading && <Loading />}
      {report.error && <ErrorBox error={report.error} />}
      {report.data && report.data.rows.length === 0 && <EmptyState message="No fixed assets on the register yet." />}
      {report.data && report.data.rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Class</th>
              <th>Cost</th>
              <th>Schedule II charge</th>
              <th>IT block charge</th>
            </tr>
          </thead>
          <tbody>
            {report.data.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.assetClass.replace('_', ' ')}</td>
                <td className="text-right">{rupees(r.cost)}</td>
                <td className="text-right">
                  {r.companiesAct.charge !== undefined ? rupees(r.companiesAct.charge) : r.companiesAct.note ?? '—'}
                  {r.companiesAct.mismatch && (
                    <span className="ml-1 text-band-watch" title={`Asset's own useful life differs from Schedule II (${r.companiesAct.usefulLifeYears} yrs)`}>
                      ⚠
                    </span>
                  )}
                </td>
                <td className="text-right">{r.incomeTax.charge != null ? rupees(r.incomeTax.charge) : r.incomeTax.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function ExportsTab() {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [from, setFrom] = useState(`${thisFyStartYear()}-04-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (label: string, path: string, fallback: string) => {
    setBusy(label);
    setError(null);
    try {
      await api.download(path, fallback);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Exports" subtitle="Auditor-facing exports. Every export is itself audited.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <TextInput label="Trial balance as of" value={asOf} onChange={setAsOf} />
          <button className="btn" disabled={busy === 'tb'} onClick={() => download('tb', `/compliance/books/trial-balance/${asOf}?format=csv`, `trial-balance-${asOf}.csv`)}>
            Download trial balance (CSV)
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <TextInput label="From" value={from} onChange={setFrom} />
          <TextInput label="To" value={to} onChange={setTo} />
          <button className="btn" disabled={busy === 'gl'} onClick={() => download('gl', `/compliance/books/general-ledger?from=${from}&to=${to}`, 'general-ledger.csv')}>
            Download general ledger (CSV)
          </button>
          <button className="btn" disabled={busy === 'tally'} onClick={() => download('tally', `/compliance/books/tally-export?from=${from}&to=${to}`, 'tally-export.xml')}>
            Download Tally export (XML)
          </button>
        </div>
        {error && <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bank reconciliation
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string;
  name: string;
}

interface ReconciliationReport {
  matchedCount: number;
  unmatchedBankCount: number;
  unmatchedLedgerCount: number;
  unmatchedBank: Array<{ id: string; date: string; amount: number | null; direction: string; reference: string | null }>;
  unmatchedLedger: Array<{ id: string; recordCode: string; date: string; amount: number | null; direction: string }>;
}

function BankTab() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['cmp-books-accounts'], queryFn: () => api.get<AccountRow[]>('/books/accounts') });
  const [accountId, setAccountId] = useState<string>('');
  const effectiveAccountId = accountId || accounts.data?.[0]?.id || '';

  const report = useQuery({
    queryKey: ['cmp-books-reconciliation', effectiveAccountId],
    queryFn: () => api.get<ReconciliationReport>(`/compliance/books/bank/${effectiveAccountId}/reconciliation`),
    enabled: Boolean(effectiveAccountId),
  });

  const match = useMutation({
    mutationFn: () => api.post(`/compliance/books/bank/${effectiveAccountId}/match`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cmp-books-reconciliation', effectiveAccountId] }),
  });

  return (
    <Card title="Bank reconciliation" subtitle="Imported statement lines are matched against the ledger by amount, direction and a ±3-day window.">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-2xs uppercase tracking-wide text-ink-500">Account</span>
          <select className="input" value={effectiveAccountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-primary" disabled={!effectiveAccountId || match.isPending} onClick={() => match.mutate()}>
          Match
        </button>
      </div>
      {report.isLoading && <Loading />}
      {report.error && <ErrorBox error={report.error} />}
      {report.data && (
        <>
          <div className="mb-4 flex flex-wrap gap-6">
            <Metric label="Matched" value={String(report.data.matchedCount)} />
            <Metric label="Unmatched bank lines" value={String(report.data.unmatchedBankCount)} tone={report.data.unmatchedBankCount ? 'warn' : 'good'} />
            <Metric label="Unmatched ledger entries" value={String(report.data.unmatchedLedgerCount)} tone={report.data.unmatchedLedgerCount ? 'warn' : 'good'} />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-200">Unmatched — bank</h3>
              {report.data.unmatchedBank.length === 0 ? (
                <EmptyState message="Nothing unmatched on the statement." />
              ) : (
                <table className="table">
                  <tbody>
                    {report.data.unmatchedBank.map((l) => (
                      <tr key={l.id}>
                        <td>{date(l.date)}</td>
                        <td>{l.direction}</td>
                        <td className="text-right">{rupees(l.amount)}</td>
                        <td>{l.reference ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink-200">Unmatched — ledger</h3>
              {report.data.unmatchedLedger.length === 0 ? (
                <EmptyState message="Nothing unmatched in the ledger." />
              ) : (
                <table className="table">
                  <tbody>
                    {report.data.unmatchedLedger.map((t) => (
                      <tr key={t.id}>
                        <td>{t.recordCode}</td>
                        <td>{date(t.date)}</td>
                        <td>{t.direction}</td>
                        <td className="text-right">{rupees(t.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

interface RetentionReport {
  policies: Array<{ entityType: string; years: number; basis: string }>;
  flaggedCount: number;
  byType: Array<{ entityType: string; count: number }>;
  flagged: Array<{ id: string; entityType: string; entityId: string; recordDate: string; dueAt: string }>;
}

function RetentionTab() {
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['cmp-books-retention'], queryFn: () => api.get<RetentionReport>('/compliance/books/retention') });
  const sweep = useMutation({
    mutationFn: () => api.post<{ flagged: number }>('/compliance/books/retention/sweep'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cmp-books-retention'] }),
  });

  return (
    <Card title="Retention" subtitle="A record past its floor is flagged for review, never deleted. Companies Act s128(5): eight financial years.">
      <button className="btn mb-4" disabled={sweep.isPending} onClick={() => sweep.mutate()}>
        {sweep.isPending ? 'Sweeping…' : 'Run sweep now'}
      </button>
      {report.isLoading && <Loading />}
      {report.error && <ErrorBox error={report.error} />}
      {report.data && (
        <>
          <table className="table mb-4">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Years</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {report.data.policies.map((p) => (
                <tr key={p.entityType}>
                  <td>{p.entityType}</td>
                  <td>{p.years}</td>
                  <td>{p.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.data.flagged.length === 0 ? (
            <EmptyState message="Nothing past its retention floor yet." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>Record date</th>
                  <th>Due for review</th>
                </tr>
              </thead>
              <tbody>
                {report.data.flagged.map((f) => (
                  <tr key={f.id}>
                    <td>{f.entityType}</td>
                    <td>{date(f.recordDate)}</td>
                    <td>{date(f.dueAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}
