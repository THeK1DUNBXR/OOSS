/**
 * The books.
 *
 * Four surfaces over the ledger: what moved, what we owe, what was planned,
 * and what the company owns and owes long-term.
 *
 * The ledger is corrected by entry, never by edit, so there is no edit control
 * on a transaction — only "reverse", which writes a second row pointing at the
 * first and leaves both visible. A row that has been reversed stays on screen
 * struck through rather than disappearing, because a reconciled bank line has
 * to keep matching something.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DIVISION_LABELS, type Division } from '@kaizen/shared';
import { api, date, money, titleCase } from '../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Metric,
  Modal,
  PageHeader,
  RecordCode,
  StatusChip,
  Withheld,
} from '../components/ui.js';
import { NewButton } from '../components/forms.js';
import {
  NewAsset, NewBudgetLine, NewCategory, NewLedgerAccount, NewLoan, NewTransaction, NewVendorBill,
} from '../components/createForms.js';

const DIVISION_STYLE: Record<string, string> = {
  software: 'bg-div-software',
  skill: 'bg-div-skill',
  education: 'bg-div-education',
  shared: 'bg-div-shared',
};

function Division({ division }: { division: string | null }) {
  if (!division) return <span className="text-ink-500">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DIVISION_STYLE[division] ?? 'bg-div-shared'}`} />
      {DIVISION_LABELS[division as Division] ?? titleCase(division)}
    </span>
  );
}

/** Withheld, never zeroed. */
function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Withheld reason="no_permission" />;
  return <span className="num">{money(value)}</span>;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

interface AccountRow {
  id: string;
  name: string;
  accountType: string;
  displayReference: string | null;
  balance: number | null;
  inflow: number | null;
  outflow: number | null;
}

interface TxnRow {
  id: string;
  recordCode: string;
  txnDate: string;
  direction: 'in' | 'out';
  amount: number | null;
  accountName: string;
  categoryName: string | null;
  categoryKind: string | null;
  division: string | null;
  counterparty: string | null;
  reference: string | null;
  note: string | null;
  source: string;
  reversalOfId: string | null;
  reversedById: string | null;
}

export function Ledger() {
  const [adding, setAdding] = useState<'txn' | 'account' | 'category' | null>(null);
  const [params, setParams] = useSearchParams();
  const [reversing, setReversing] = useState<TxnRow | null>(null);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();

  const categoryId = params.get('categoryId') ?? '';
  const division = params.get('division') ?? '';

  const accounts = useQuery({
    queryKey: ['books-accounts'],
    queryFn: () => api.get<AccountRow[]>('/books/accounts'),
    retry: false,
  });

  const categories = useQuery({
    queryKey: ['books-categories'],
    queryFn: () => api.get<Array<{ id: string; name: string; kind: string }>>('/books/categories'),
    retry: false,
  });

  const query = new URLSearchParams();
  if (categoryId) query.set('categoryId', categoryId);
  if (division) query.set('division', division);

  const txns = useQuery({
    queryKey: ['books-txns', categoryId, division],
    queryFn: () => api.get<TxnRow[]>(`/books/transactions?${query.toString()}`),
    retry: false,
  });

  const reverse = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/books/transactions/${v.id}/reverse`, { reason: v.reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['books-txns'] });
      void qc.invalidateQueries({ queryKey: ['books-accounts'] });
      setReversing(null);
      setReason('');
    },
  });

  if (txns.isError) return <ErrorBox error={txns.error} />;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Ledger"
        subtitle="Every movement of money, whatever raised it — a bank import, a payroll disbursement, a supplier payment or somebody typing it in. Nothing is deleted: a mistake is reversed with a second entry, and both stay."
        actions={
          <>
            <button className="btn" onClick={() => setAdding('category')}>+ Category</button>
            <button className="btn" onClick={() => setAdding('account')}>+ Account</button>
            <NewButton label="Record money" onClick={() => setAdding('txn')} />
          </>
        }
      />
      <NewTransaction open={adding === 'txn'} onClose={() => setAdding(null)} />
      <NewLedgerAccount open={adding === 'account'} onClose={() => setAdding(null)} />
      <NewCategory open={adding === 'category'} onClose={() => setAdding(null)} />

      {accounts.data && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.data.map((a) => (
            <Metric
              key={a.id}
              label={a.name}
              value={a.balance === null ? <Withheld reason="no_permission" /> : money(a.balance)}
              sub={`${titleCase(a.accountType)}${a.displayReference ? ` · ${a.displayReference}` : ''}`}
              tone={(a.balance ?? 0) < 0 ? 'bad' : 'neutral'}
            />
          ))}
        </div>
      )}

      {/* Filters in one row above the table. */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <label className="label">Line</label>
            <select className="input" value={categoryId} onChange={(e) => setFilter('categoryId', e.target.value)}>
              <option value="">Everything</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="w-56">
            <label className="label">Division</label>
            <select className="input" value={division} onChange={(e) => setFilter('division', e.target.value)}>
              <option value="">All divisions</option>
              {(Object.keys(DIVISION_LABELS) as Division[]).map((d) => (
                <option key={d} value={d}>
                  {DIVISION_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          {(categoryId || division) && (
            <button className="btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Clear
            </button>
          )}
        </div>
      </Card>

      {txns.isLoading ? (
        <Loading />
      ) : !txns.data?.length ? (
        <Card>
          <EmptyState message="Nothing matches." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Date</th>
                  <th>Line</th>
                  <th>Division</th>
                  <th>Counterparty</th>
                  <th>Account</th>
                  <th>Source</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {txns.data.map((t) => {
                  const reversed = Boolean(t.reversedById);
                  return (
                    <tr key={t.id} className={reversed ? 'opacity-55' : ''}>
                      <td>
                        <RecordCode code={t.recordCode} />
                      </td>
                      <td className="num">{t.txnDate}</td>
                      <td className={reversed ? 'line-through' : ''}>
                        {t.categoryName ?? <span className="text-ink-500">Uncategorised</span>}
                        {t.note && <div className="text-2xs text-ink-500">{t.note}</div>}
                      </td>
                      <td>
                        <Division division={t.division} />
                      </td>
                      <td>{t.counterparty ?? '—'}</td>
                      <td className="text-2xs text-ink-500">{t.accountName}</td>
                      <td>
                        <StatusChip status={t.source.replace(/_/g, ' ')} tone={t.source === 'manual' ? 'neutral' : 'accent'} />
                      </td>
                      <td className="num">{t.direction === 'in' ? <Money value={t.amount} /> : ''}</td>
                      <td className="num">{t.direction === 'out' ? <Money value={t.amount} /> : ''}</td>
                      <td>
                        {t.reversalOfId ? (
                          <span className="chip-neutral">reversal</span>
                        ) : reversed ? (
                          <span className="chip-neutral">reversed</span>
                        ) : (
                          <button className="btn-ghost btn-sm" onClick={() => setReversing(t)}>
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={reversing !== null}
        title={`Reverse ${reversing?.recordCode ?? ''}`}
        onClose={() => setReversing(null)}
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setReversing(null)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={!reason.trim() || reverse.isPending}
              onClick={() => reverse.mutate({ id: reversing!.id, reason })}
            >
              Post the reversal
            </button>
          </>
        }
      >
        <p className="mb-3 text-xs leading-relaxed text-ink-400">
          This writes an opposite entry pointing at the original. Both stay on the ledger, so a bank line already
          matched against the original keeps matching it.
        </p>
        <label className="label">Why</label>
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        {reverse.error && (
          <div className="mt-3">
            <ErrorBox error={reverse.error} />
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier bills
// ---------------------------------------------------------------------------

interface BillRow {
  id: string;
  recordCode: string;
  vendorName: string;
  billNumber: string | null;
  billDate: string;
  dueDate: string | null;
  division: string | null;
  status: string;
  total: number | null;
  paidAmount: number | null;
  outstanding: number | null;
  daysOverdue: number | null;
}

export function Payables() {
  const [adding, setAdding] = useState<'bill' | null>(null);
  const [paying, setPaying] = useState<BillRow | null>(null);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const qc = useQueryClient();

  const bills = useQuery({
    queryKey: ['books-bills'],
    queryFn: () => api.get<BillRow[]>('/books/vendor-bills'),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['books-accounts'],
    queryFn: () => api.get<AccountRow[]>('/books/accounts'),
    retry: false,
  });

  const pay = useMutation({
    mutationFn: (v: { id: string; amount: number; accountId: string }) =>
      api.post(`/books/vendor-bills/${v.id}/pay`, { amount: v.amount, accountId: v.accountId, paidOn: new Date().toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['books-bills'] });
      void qc.invalidateQueries({ queryKey: ['books-accounts'] });
      void qc.invalidateQueries({ queryKey: ['books-txns'] });
      setPaying(null);
      setAmount('');
    },
  });

  if (bills.isError) return <ErrorBox error={bills.error} />;

  const open = (bills.data ?? []).filter((b) => ['open', 'part_paid'].includes(b.status));
  const overdue = open.filter((b) => b.daysOverdue !== null);
  const outstanding = open.reduce((s, b) => s + (b.outstanding ?? 0), 0);
  const amountsVisible = open.every((b) => b.outstanding !== null);

  return (
    <div>
      <NewVendorBill open={adding === 'bill'} onClose={() => setAdding(null)} />
      <PageHeader
        actions={<NewButton label="Record a bill" onClick={() => setAdding('bill')} />}
        title="What we owe"
        subtitle="Supplier bills. The company could always see what it was owed; without this it could not see its own position."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Open bills" value={open.length} />
        <Metric
          label="Outstanding"
          value={amountsVisible ? money(outstanding) : <Withheld reason="no_permission" />}
          tone={outstanding > 0 ? 'warn' : 'good'}
        />
        <Metric label="Overdue" value={overdue.length} tone={overdue.length > 0 ? 'bad' : 'good'} drillTo="/exceptions" />
      </div>

      {bills.isLoading ? (
        <Loading />
      ) : !bills.data?.length ? (
        <Card>
          <EmptyState message="No supplier bills recorded." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Supplier</th>
                  <th>Bill</th>
                  <th>Due</th>
                  <th>Division</th>
                  <th className="num">Total</th>
                  <th className="num">Outstanding</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <RecordCode code={b.recordCode} />
                    </td>
                    <td className="font-semibold">{b.vendorName}</td>
                    <td className="text-2xs text-ink-500">{b.billNumber ?? '—'}</td>
                    <td className="num">
                      {b.dueDate ? date(b.dueDate) : '—'}
                      {b.daysOverdue !== null && (
                        <div className="text-2xs font-semibold text-band-critical">{b.daysOverdue}d late</div>
                      )}
                    </td>
                    <td>
                      <Division division={b.division} />
                    </td>
                    <td className="num">
                      <Money value={b.total} />
                    </td>
                    <td className="num">
                      <Money value={b.outstanding} />
                    </td>
                    <td>
                      <StatusChip
                        status={b.status.replace(/_/g, ' ')}
                        tone={b.status === 'paid' ? 'good' : b.daysOverdue !== null ? 'bad' : 'warn'}
                      />
                    </td>
                    <td>
                      {['open', 'part_paid'].includes(b.status) && (
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => {
                            setPaying(b);
                            setAmount(String(b.outstanding ?? ''));
                            setAccountId(accounts.data?.[0]?.id ?? '');
                          }}
                        >
                          Pay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={paying !== null}
        title={`Pay ${paying?.vendorName ?? ''}`}
        onClose={() => setPaying(null)}
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setPaying(null)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              disabled={!amount || !accountId || pay.isPending}
              onClick={() => pay.mutate({ id: paying!.id, amount: Number(amount), accountId })}
            >
              Record the payment
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Amount</label>
            <input className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            <p className="mt-1 text-2xs text-ink-500">
              Outstanding on this bill: {paying?.outstanding === null ? 'withheld' : money(paying?.outstanding ?? 0)}. Paying
              more than that needs a credit note, not a larger payment.
            </p>
          </div>
          <div>
            <label className="label">From</label>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          {pay.error && <ErrorBox error={pay.error} />}
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

interface VarianceRow {
  categoryId: string;
  categoryName: string;
  division: string | null;
  budget: number | null;
  actual: number | null;
  variance: number | null;
  overspent: boolean;
}

export function Budget() {
  const [adding, setAdding] = useState(false);
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));

  const { data, isLoading, error } = useQuery({
    queryKey: ['books-budget', period],
    queryFn: () =>
      api.get<{ period: string; budgetTotal: number | null; actualTotal: number | null; variance: number | null; rows: VarianceRow[] }>(
        `/books/budget/variance?period=${period}`,
      ),
    retry: false,
  });

  if (error) return <ErrorBox error={error} />;

  const over = (data?.rows ?? []).filter((r) => r.overspent);

  return (
    <div>
      <NewBudgetLine open={adding} onClose={() => setAdding(false)} period={period} />
      <PageHeader
        title="Budget"
        subtitle="What was planned against what was spent. The spend is summed from the ledger each time this loads, so an entry made late moves the variance instead of leaving a number that was true on the day somebody wrote it."
        actions={
          <>
            <input type="month" className="input w-40" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
            <NewButton label="Set a budget line" onClick={() => setAdding(true)} />
          </>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Planned" value={data?.budgetTotal === null ? <Withheld reason="no_permission" /> : money(data?.budgetTotal ?? 0)} />
        <Metric label="Spent" value={data?.actualTotal === null ? <Withheld reason="no_permission" /> : money(data?.actualTotal ?? 0)} />
        <Metric
          label="Lines over plan"
          value={over.length}
          tone={over.length > 0 ? 'warn' : 'good'}
          sub={over.length ? 'Including anything spent with no line to sit against' : undefined}
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : !data?.rows.length ? (
        <Card>
          <EmptyState message="No budget set for this month." hint="Without a plan there is nothing to be over or under." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Division</th>
                  <th className="num">Planned</th>
                  <th className="num">Spent</th>
                  <th className="num">Variance</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.categoryId}-${r.division ?? ''}`}>
                    <td>
                      {r.categoryName}
                      {r.budget === 0 && <span className="ml-1.5 chip-gold">unbudgeted</span>}
                    </td>
                    <td>
                      <Division division={r.division} />
                    </td>
                    <td className="num">{r.budget === null ? '—' : money(r.budget)}</td>
                    <td className="num">{r.actual === null ? '—' : money(r.actual)}</td>
                    <td className={`num font-semibold ${r.overspent ? 'text-band-critical' : 'text-band-strong'}`}>
                      {r.variance === null ? (r.overspent ? 'over' : 'within') : money(r.variance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assets and borrowing
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  recordCode: string;
  name: string;
  purchaseDate: string;
  cost: number | null;
  method: string;
  division: string | null;
  bookValue: number | null;
  accumulatedDepreciation: number | null;
  disposedAt: string | null;
}

interface LoanRow {
  id: string;
  recordCode: string;
  lender: string;
  principal: number | null;
  annualRate: number;
  tenureMonths: number;
  startDate: string;
  outstanding: number | null;
  instalment: number | null;
  interestThisMonth: number | null;
  closedAt: string | null;
}

export function Assets() {
  const [adding, setAdding] = useState<'asset' | 'loan' | null>(null);
  const assets = useQuery({ queryKey: ['books-assets'], queryFn: () => api.get<AssetRow[]>('/books/assets'), retry: false });
  const loans = useQuery({ queryKey: ['books-loans'], queryFn: () => api.get<LoanRow[]>('/books/loans'), retry: false });

  if (assets.isError) return <ErrorBox error={assets.error} />;

  const bookValue = (assets.data ?? []).reduce((s, a) => s + (a.bookValue ?? 0), 0);
  const owed = (loans.data ?? []).reduce((s, l) => s + (l.outstanding ?? 0), 0);
  const visible = (assets.data ?? []).every((a) => a.bookValue !== null);

  return (
    <div>
      <NewAsset open={adding === 'asset'} onClose={() => setAdding(null)} />
      <NewLoan open={adding === 'loan'} onClose={() => setAdding(null)} />
      <PageHeader
        actions={
          <>
            <button className="btn" onClick={() => setAdding('loan')}>+ Borrowing</button>
            <NewButton label="Add an asset" onClick={() => setAdding('asset')} />
          </>
        }
        title="Assets and borrowing"
        subtitle="What the company owns and what it owes over time. Both schedules are worked out on demand rather than stored, so correcting a useful life or a rate fixes every future period at once."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Assets" value={assets.data?.length ?? 0} />
        <Metric label="Carrying value" value={visible ? money(bookValue) : <Withheld reason="no_permission" />} />
        <Metric
          label="Still owed"
          value={loans.data?.every((l) => l.outstanding !== null) ? money(owed) : <Withheld reason="no_permission" />}
          tone={owed > 0 ? 'warn' : 'good'}
        />
      </div>

      <Card title="Fixed assets" className="mb-4" bodyClassName="p-0">
        {assets.isLoading ? (
          <Loading />
        ) : !assets.data?.length ? (
          <EmptyState message="No assets recorded." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Asset</th>
                  <th>Bought</th>
                  <th>Division</th>
                  <th>Method</th>
                  <th className="num">Cost</th>
                  <th className="num">Written down</th>
                  <th className="num">Carrying value</th>
                </tr>
              </thead>
              <tbody>
                {assets.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <RecordCode code={a.recordCode} />
                    </td>
                    <td className="font-semibold">{a.name}</td>
                    <td className="num">{date(a.purchaseDate)}</td>
                    <td>
                      <Division division={a.division} />
                    </td>
                    <td className="text-2xs uppercase tracking-wide text-ink-500">
                      {a.method === 'wdv' ? 'Written-down value' : 'Straight line'}
                    </td>
                    <td className="num">
                      <Money value={a.cost} />
                    </td>
                    <td className="num">
                      <Money value={a.accumulatedDepreciation} />
                    </td>
                    <td className="num font-semibold">
                      <Money value={a.bookValue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Borrowing" bodyClassName="p-0">
        {loans.isLoading ? (
          <Loading />
        ) : !loans.data?.length ? (
          <EmptyState message="No loans recorded." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Lender</th>
                  <th>From</th>
                  <th className="num">Rate</th>
                  <th className="num">Term</th>
                  <th className="num">Instalment</th>
                  <th className="num">Interest this month</th>
                  <th className="num">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {loans.data.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <RecordCode code={l.recordCode} />
                    </td>
                    <td className="font-semibold">{l.lender}</td>
                    <td className="num">{date(l.startDate)}</td>
                    <td className="num">{l.annualRate}%</td>
                    <td className="num">{l.tenureMonths} mo</td>
                    <td className="num">
                      <Money value={l.instalment} />
                    </td>
                    <td className="num">
                      <Money value={l.interestThisMonth} />
                    </td>
                    <td className="num font-semibold">
                      <Money value={l.outstanding} />
                    </td>
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
