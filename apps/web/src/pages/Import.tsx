/**
 * Bringing a company's history in.
 *
 * The screen is built around one claim: you will see what this is about to do
 * before it does it. Drop a file, read what the platform thinks it is, look at
 * the rows it will create and the rows it will leave out and why, then commit —
 * or revert afterwards, which removes exactly what the batch created.
 *
 * That shape is not caution for its own sake. The first import a company does
 * is usually a year of their books, and the difference between an importer they
 * trust and one they abandon is whether the first attempt was reversible.
 */

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, money, relative } from '../lib/api.js';
import {
  Card, EmptyState, ErrorBox, Loading, PageHeader, RecordCode, StatusChip,
} from '../components/ui.js';
import { messageOf, SelectInput } from '../components/forms.js';

interface Detection {
  kind: string;
  sheet?: string;
  headerRow?: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface StageResult {
  batchId: string;
  recordCode: string;
  kind: string;
  sourceFormat: string;
  sourceLabel: string | null;
  detection: Detection;
  otherSheets: Detection[];
  notes: string[];
  columns: string[];
  stats: Record<string, number>;
  duplicateOfBatch?: { id: string; recordCode: string; fileName: string; committedAt: string | null };
}

interface Batch {
  id: string;
  recordCode: string;
  fileName: string;
  fileSize: number;
  kind: string;
  sourceFormat: string;
  sourceLabel: string | null;
  status: string;
  stats: Record<string, unknown>;
  committedAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  rowNumber: number;
  raw: Record<string, unknown>;
  normalised: Record<string, unknown> | null;
  status: string;
  message: string | null;
}

const KIND_LABEL: Record<string, string> = {
  tally_ledger: 'Tally ledger export',
  chart_of_accounts: 'Chart of accounts',
  bank_statement: 'Bank statement',
  transactions: 'Transactions',
  employees: 'Staff list',
  salary: 'Salary sheet',
  attendance: 'Attendance sheet',
  student_register: 'Student register',
  // The templates this platform hands out, named the way the download button
  // named them. A row in the history reading "template_students" is the
  // internal key leaking onto a screen.
  template_courses: 'Courses template',
  template_batches: 'Training batches template',
  template_colleges: 'Colleges template',
  template_clients: 'Client companies template',
  template_students: 'Students template',
  template_contacts: 'Contacts template',
  template_staff: 'Staff template',
  template_ledger_accounts: 'Bank & cash accounts template',
  template_ledger_categories: 'Income & expense categories template',
  template_vendor_bills: 'Bills to pay template',
  unknown: 'Not recognised',
};

const KIND_EFFECT: Record<string, string> = {
  tally_ledger: 'Creates ledger accounts, categories and transactions.',
  chart_of_accounts: 'Creates ledger accounts and spending categories. No transactions.',
  bank_statement: 'Creates transactions against the account you choose below.',
  transactions: 'Creates transactions against the account you choose below.',
  employees: 'Creates people, their seats and their employment records.',
  salary: 'Sets the pay in force for each person named. They must already be on the staff list.',
  attendance: 'Records attendance days against each person named.',
  student_register:
    'Creates the courses named and enrols each student, keeping the registration number from the register. ' +
    'Fees and instalments are reported but not saved \u2014 nothing is billed.',
  template_courses: 'Creates courses. A code already on file is left alone rather than duplicated.',
  template_batches: 'Creates training batches against courses already on file.',
  template_colleges: 'Creates colleges, so students can be recorded as coming from them.',
  template_clients: 'Creates organisations and marks them as clients you invoice.',
  template_students: 'Enrols people onto batches, matching anybody already on file rather than copying them.',
  template_contacts: 'Creates people and attaches them to the company or college they are at.',
  template_staff: 'Creates people, their seats and their employment records. Never their pay.',
  template_ledger_accounts: 'Creates bank, cash, card and loan accounts. A name already on file is left alone.',
  template_ledger_categories: 'Creates the categories money is earned or spent under. A name already on file is left alone.',
  template_vendor_bills: 'Creates unpaid vendor bills against categories already on file.',
  unknown: 'Nothing, until you say what it is.',
};

export default function ImportPage() {
  const qc = useQueryClient();
  const [staged, setStaged] = useState<StageResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);

  const batches = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<Batch[]>('/imports'),
  });

  const upload = useMutation({
    mutationFn: (input: { file: File; kind?: string; sheet?: string }) =>
      api.upload<StageResult>('/imports', input.file, {
        ...(input.kind ? { 'X-Import-Kind': input.kind } : {}),
        ...(input.sheet ? { 'X-Import-Sheet': input.sheet } : {}),
      }),
    onSuccess: (result) => {
      setStaged(result);
      setUploadError(null);
      qc.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (e) => setUploadError(messageOf(e)),
  });

  const take = (file: File | undefined) => {
    if (!file) return;
    setPending(file);
    setStaged(null);
    upload.mutate({ file });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Bring your data in"
        subtitle="A Tally export, a bank statement, a salary sheet, or one of our templates."
      />

      <Card>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            take(e.dataTransfer.files[0]);
          }}
          className={`flex flex-col items-center gap-2 rounded border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/5' : 'border-ink-700'
          }`}
        >
          <p className="text-sm text-ink-200">Drop a file here, or</p>
          <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? 'Reading…' : 'Choose a file'}
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,.csv,.xml,.txt"
            onChange={(e) => take(e.target.files?.[0])}
          />
          <p className="mt-2 max-w-lg text-2xs text-ink-500">
            Excel, CSV or a Tally XML export, up to 25MB.
          </p>
        </div>

        {uploadError && (
          <p className="mt-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
            {uploadError}
          </p>
        )}
      </Card>

      <Templates />

      {staged && (
        <Preview
          staged={staged}
          onReplace={(kind, sheet) => pending && upload.mutate({ file: pending, kind, sheet })}
          onDone={() => {
            setStaged(null);
            setPending(null);
            qc.invalidateQueries();
          }}
        />
      )}

      <History batches={batches} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The blank files
// ---------------------------------------------------------------------------

interface Template {
  slug: string;
  title: string;
  what: string;
  needsFirst: string | null;
  columns: Array<{ name: string; required: boolean; note: string }>;
  notes: string[];
}

/**
 * Templates for the lists the company keeps itself.
 *
 * A Tally export and a bank statement arrive in somebody else's shape and this
 * platform works hard to read them. Your own course list has no such excuse to
 * be a surprise: here is the file, with the headings already on it and a sheet
 * saying what each one wants.
 *
 * Shown in the order they have to be imported. Students point at a batch by
 * name and a batch points at a course by code, so a student list uploaded first
 * is a page of red rows saying "no batch is called that" — true, unhelpful, and
 * avoidable by putting them in the right order on the screen.
 */
function Templates() {
  const [open, setOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['import-templates'],
    queryFn: () => api.get<{ items: Template[] }>('/imports/templates'),
  });

  const grab = async (slug: string) => {
    try {
      setFailed(null);
      await api.download(`/imports/templates/${slug}`, `kaizen-${slug}-template.xlsx`);
    } catch (e) {
      setFailed(messageOf(e));
    }
  };

  if (isLoading || !data?.items.length) return null;

  return (
    <Card
      title="Or start from a template"
      subtitle="Download it, fill it in, upload it back. Import what points at nothing first."
    >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((t, i) => (
          <div key={t.slug} className="rounded-lg border border-ink-800 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-ink-100">
                  <span className="mr-1.5 text-ink-600">{i + 1}.</span>
                  {t.title}
                </p>
                <p className="mt-0.5 text-2xs text-ink-500">{t.what}</p>
              </div>
              <button className="btn shrink-0" onClick={() => grab(t.slug)}>
                Download
              </button>
            </div>

            {t.needsFirst && (
              <p className="mt-2 text-2xs text-ink-600">
                Needs first: <span className="text-ink-400">{t.needsFirst}</span>
              </p>
            )}

            <button
              type="button"
              className="mt-2 text-2xs text-ink-500 underline decoration-ink-700 underline-offset-2 hover:text-accent-soft"
              onClick={() => setOpen(open === t.slug ? null : t.slug)}
            >
              {open === t.slug ? 'Hide the columns' : `What is in it (${t.columns.length} columns)`}
            </button>

            {open === t.slug && (
              <div className="mt-2 space-y-1.5 border-t border-ink-850 pt-2">
                {t.columns.map((c) => (
                  <p key={c.name} className="text-2xs">
                    <span className="text-ink-200">{c.name}</span>
                    {c.required && <span className="ml-1 text-band-critical">required</span>}
                    {c.note && <span className="block text-ink-600">{c.note}</span>}
                  </p>
                ))}
                {t.notes.map((n) => (
                  <p key={n} className="text-2xs text-ink-500">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {failed && <p className="mt-3 text-2xs text-band-critical">{failed}</p>}

      <p className="mt-3 text-2xs text-ink-500">
        Examples are on the second sheet, so they cannot be uploaded by mistake.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function Preview({
  staged,
  onReplace,
  onDone,
}: {
  staged: StageResult;
  onReplace: (kind?: string, sheet?: string) => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: Record<string, number>; errors: Array<{ rowNumber: number; message: string }> } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [division, setDivision] = useState('');
  const [showing, setShowing] = useState<'ready' | 'skipped' | 'duplicate' | 'error'>('ready');

  const needsAccount = staged.kind === 'bank_statement' || staged.kind === 'transactions';

  const accounts = useQuery({
    queryKey: ['ledger-accounts'],
    queryFn: () => api.get<Array<{ id: string; name: string; accountType: string }>>('/books/accounts'),
    enabled: needsAccount,
  });

  const rows = useQuery({
    queryKey: ['import-rows', staged.batchId, showing],
    queryFn: () => api.get<Row[]>(`/imports/${staged.batchId}/rows?status=${showing}&limit=200`),
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (needsAccount || division) {
        await api.patch(`/imports/${staged.batchId}/options`, {
          ...(accountId ? { accountId } : {}),
          ...(division ? { defaultDivision: division } : {}),
        });
      }
      return api.post<{ created: Record<string, number>; errors: Array<{ rowNumber: number; message: string }> }>(
        `/imports/${staged.batchId}/commit`,
      );
    },
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      qc.invalidateQueries();
    },
    onError: (e) => setError(messageOf(e)),
  });

  const stats = staged.stats;
  const ready = stats.ready ?? 0;

  if (result) {
    return (
      <Card title="Done">
        <div className="flex flex-col gap-3">
          <ul className="flex flex-wrap gap-4">
            {Object.entries(result.created).map(([what, n]) => (
              <li key={what} className="text-sm text-ink-200">
                <span className="font-display text-lg tabular-nums text-ink-50">{n}</span>{' '}
                {friendlyEntity(what, n)}
              </li>
            ))}
            {Object.keys(result.created).length === 0 && <li className="text-sm text-ink-400">Nothing was created.</li>}
          </ul>

          {result.errors.length > 0 && (
            <div>
              <p className="label mb-1">{result.errors.length} rows could not be brought in</p>
              <ul className="flex flex-col gap-1">
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e.rowNumber} className="text-sm text-ink-300">
                    <span className="text-ink-500">Row {e.rowNumber}</span> — {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <button className="btn-primary" onClick={onDone}>
              Import something else
            </button>
            <RevertButton batchId={staged.batchId} onDone={onDone} />
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={KIND_LABEL[staged.kind] ?? staged.kind}
      subtitle={staged.detection.reason}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <RecordCode code={staged.recordCode} />
          <StatusChip status={KIND_LABEL[staged.kind] ?? staged.kind} tone="accent" />
          {staged.sourceLabel && <StatusChip status={`sheet: ${staged.sourceLabel}`} />}
          <span className="text-2xs text-ink-500">{KIND_EFFECT[staged.kind]}</span>
        </div>

        {staged.duplicateOfBatch && (
          <p className="rounded border-l-2 border-band-watch bg-band-watch/10 px-3 py-2 text-sm text-band-watch">
            This is the same file as {staged.duplicateOfBatch.recordCode} ({staged.duplicateOfBatch.fileName}),
            {staged.duplicateOfBatch.committedAt ? ' which was already brought in.' : ' which was uploaded and not committed.'}{' '}
            Rows it already created are marked as duplicates below and will be left alone.
          </p>
        )}

        <ul className="flex flex-col gap-1">
          {staged.notes.map((note) => (
            <li key={note} className="text-sm text-ink-300">
              {note}
            </li>
          ))}
        </ul>

        {/* What it found, as counts you can click. */}
        <div className="flex flex-wrap gap-2">
          {(['ready', 'duplicate', 'skipped', 'error'] as const).map((key) => {
            const n = stats[key] ?? 0;
            if (n === 0 && key !== 'ready') return null;
            return (
              <button
                key={key}
                onClick={() => setShowing(key)}
                className={`rounded border px-3 py-1.5 text-left transition-colors ${
                  showing === key ? 'border-accent bg-accent/10' : 'border-ink-700 hover:border-ink-600'
                }`}
              >
                <span className="block font-display text-lg tabular-nums text-ink-50">{n}</span>
                <span className="block text-2xs uppercase tracking-wide text-ink-500">{ROW_STATUS_LABEL[key]}</span>
              </button>
            );
          })}
        </div>

        {/* Corrections, before anything is written. */}
        {staged.otherSheets.length > 1 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectInput
              label="Sheet"
              hint="if the wrong one was picked"
              value={staged.sourceLabel ?? ''}
              onChange={(v) => onReplace(undefined, v)}
              options={staged.otherSheets
                .filter((s) => s.sheet)
                .map((s) => ({ value: s.sheet!, label: `${s.sheet} — ${KIND_LABEL[s.kind] ?? s.kind}` }))}
            />
            <SelectInput
              label="Treat this as"
              hint="if the guess is wrong"
              value={staged.kind}
              onChange={(v) => onReplace(v, staged.sourceLabel ?? undefined)}
              options={Object.entries(KIND_LABEL)
                .filter(([k]) => k !== 'unknown')
                .map(([value, label]) => ({ value, label }))}
            />
          </div>
        )}

        {needsAccount && (
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectInput
              label="Which account is this statement for"
              required
              value={accountId}
              onChange={setAccountId}
              placeholder={accounts.data?.length ? 'Choose an account' : 'No accounts yet — create one first'}
              options={(accounts.data ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.accountType})` }))}
            />
            <SelectInput
              label="Division"
              hint="applied to every row"
              value={division}
              onChange={setDivision}
              placeholder="Decide per transaction later"
              options={[
                { value: 'software', label: 'Software' },
                { value: 'skill', label: 'Skill Development' },
                { value: 'education', label: 'Education' },
                { value: 'shared', label: 'Shared' },
              ]}
            />
          </div>
        )}

        <RowTable rows={rows} showing={showing} kind={staged.kind} />

        {error && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            className="btn-primary"
            onClick={() => commit.mutate()}
            disabled={commit.isPending || ready === 0 || (needsAccount && !accountId)}
          >
            {commit.isPending ? 'Bringing it in…' : `Bring in ${ready} ${ready === 1 ? 'row' : 'rows'}`}
          </button>
          <button className="btn" onClick={onDone}>
            Not now
          </button>
          {ready === 0 && (
            <span className="text-2xs text-ink-500">
              Every row is a duplicate, a blank or an error, so there is nothing to bring in.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

const ROW_STATUS_LABEL: Record<string, string> = {
  ready: 'will be brought in',
  duplicate: 'already here',
  skipped: 'left out',
  error: 'could not be read',
};

function RowTable({ rows, showing, kind }: { rows: ReturnType<typeof useQuery<Row[]>>; showing: string; kind: string }) {
  if (rows.isLoading) return <Loading label="Reading the file" />;
  if (rows.error) return <ErrorBox error={rows.error} />;
  const data = rows.data ?? [];
  if (data.length === 0) {
    return <EmptyState message={`No rows ${ROW_STATUS_LABEL[showing] ?? showing}.`} />;
  }

  const columns = columnsFor(kind);

  return (
    <div className="max-h-96 overflow-auto rounded border border-ink-800">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-ink-900 text-2xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-2 py-1.5 text-left font-normal">Row</th>
            {columns.map((c) => (
              <th key={c.key} className={`px-2 py-1.5 font-normal ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                {c.label}
              </th>
            ))}
            {showing !== 'ready' && <th className="px-2 py-1.5 text-left font-normal">Why</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const source = (row.normalised ?? row.raw) as Record<string, unknown>;
            return (
              <tr key={row.id} className="border-t border-ink-850">
                <td className="px-2 py-1.5 tabular-nums text-ink-500">{row.rowNumber}</td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-2 py-1.5 ${c.align === 'right' ? 'text-right tabular-nums' : ''} text-ink-200`}
                  >
                    {c.render(source, row)}
                  </td>
                ))}
                {showing !== 'ready' && <td className="px-2 py-1.5 text-ink-400">{row.message}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Column {
  key: string;
  label: string;
  align?: 'right';
  render: (source: Record<string, unknown>, row: Row) => string;
}

const text = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

function columnsFor(kind: string): Column[] {
  switch (kind) {
    case 'tally_ledger':
      return [
        { key: 'date', label: 'Date', render: (s) => shortDate(s.txnDate ?? s.date) },
        { key: 'ledger', label: 'Ledger', render: (s) => text(s.ledger) },
        { key: 'contra', label: 'Against', render: (s) => text(s.contraAccount) },
        { key: 'ref', label: 'Voucher', render: (s) => `${text(s.voucherType)} ${text(s.voucherNo)}`.trim() },
        { key: 'amount', label: 'Amount', align: 'right', render: (s) => amountText(s.amount) },
      ];
    case 'bank_statement':
    case 'transactions':
      return [
        { key: 'date', label: 'Date', render: (s) => shortDate(s.txnDate ?? s.date) },
        { key: 'desc', label: 'Description', render: (s) => truncate(text(s.narration ?? s.description), 60) },
        { key: 'party', label: 'Counterparty', render: (s) => text(s.counterparty) },
        { key: 'dir', label: 'In / out', render: (s) => (s.direction === 'in' ? 'In' : s.direction === 'out' ? 'Out' : '—') },
        { key: 'amount', label: 'Amount', align: 'right', render: (s) => amountText(s.amount) },
      ];
    case 'employees':
      return [
        { key: 'name', label: 'Name', render: (s) => text(s.fullName ?? s.Name) },
        { key: 'designation', label: 'Designation', render: (s) => text(s.designation) },
        { key: 'division', label: 'Division', render: (s) => text(s.division) },
        { key: 'code', label: 'Employee code', render: (s) => text(s.employeeCode) },
      ];
    case 'student_register':
      // The fee and what has been received are shown even though neither is
      // written. They are what a person checks the preview against — a row whose
      // figures do not add up is the row worth looking at, and hiding the money
      // because the import does not write it would hide the reason it is flagged.
      return [
        { key: 'name', label: 'Student', render: (s) => text(s.fullName) },
        { key: 'registration', label: 'Registration no.', render: (s) => text(s.registrationNumber) },
        { key: 'course', label: 'Course', render: (s) => text(s.courseName) },
        { key: 'starts', label: 'Starts', render: (s) => shortDate(s.startsOn) },
        { key: 'fee', label: 'Fee (not imported)', align: 'right', render: (s) => amountText(s.total) },
        { key: 'received', label: 'Received (not imported)', align: 'right', render: (s) => amountText(s.received) },
        {
          key: 'instalments',
          label: 'Receipts',
          render: (s) =>
            Array.isArray(s.instalments) && s.instalments.length
              ? (s.instalments as Array<{ receiptNumber?: string | null }>)
                  .map((r) => r.receiptNumber ?? '—')
                  .join(', ')
              : '—',
        },
      ];
    case 'salary':
      return [
        { key: 'name', label: 'Name', render: (s) => text(s.fullName) },
        { key: 'designation', label: 'Designation', render: (s) => text(s.designation) },
        { key: 'amount', label: 'Monthly', align: 'right', render: (s) => amountText(s.monthlyAmount) },
        { key: 'net', label: 'Net paid', align: 'right', render: (s) => amountText(s.netPay) },
      ];
    case 'attendance':
      return [
        { key: 'name', label: 'Name', render: (s) => text(s.fullName) },
        { key: 'month', label: 'Month', render: (s) => text(s.monthLabel) },
        {
          key: 'days',
          label: 'Days',
          align: 'right',
          render: (s) => String((s.days as unknown[] | undefined)?.length ?? 0),
        },
      ];
    case 'chart_of_accounts':
      return [
        { key: 'name', label: 'Account', render: (s) => text(s.name) },
        { key: 'dr', label: 'Debit', align: 'right', render: (s) => amountText(s.closingDebit) },
        { key: 'cr', label: 'Credit', align: 'right', render: (s) => amountText(s.closingCredit) },
      ];
    default:
      return [{ key: 'raw', label: 'Content', render: (s) => truncate(JSON.stringify(s), 90) }];
  }
}

const shortDate = (v: unknown): string => (v ? date(String(v)) : '—');
const amountText = (v: unknown): string => (typeof v === 'number' ? money(v) : v ? money(Number(v)) : '—');
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function friendlyEntity(what: string, n: number): string {
  const names: Record<string, [string, string]> = {
    transaction: ['transaction', 'transactions'],
    person: ['person', 'people'],
    compensationRecord: ['pay record', 'pay records'],
    workAttendance: ['attendance record', 'attendance records'],
    ledgerAccount: ['account', 'accounts'],
    ledgerCategory: ['category', 'categories'],
  };
  const pair = names[what] ?? [what, `${what}s`];
  return n === 1 ? pair[0] : pair[1];
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function RevertButton({ batchId, onDone }: { batchId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revert = useMutation({
    mutationFn: () => api.post(`/imports/${batchId}/revert`),
    onSuccess: () => {
      qc.invalidateQueries();
      onDone();
    },
  });

  if (!confirming) {
    return (
      <button className="btn" onClick={() => setConfirming(true)}>
        Undo this import
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-2xs text-ink-400">Remove everything this file created?</span>
      <button className="btn-danger" onClick={() => revert.mutate()} disabled={revert.isPending}>
        {revert.isPending ? 'Undoing…' : 'Yes, undo it'}
      </button>
      <button className="btn" onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </span>
  );
}

function History({ batches }: { batches: ReturnType<typeof useQuery<Batch[]>> }) {
  if (batches.isLoading) return <Loading label="Loading imports" />;
  if (batches.error) return <ErrorBox error={batches.error} />;
  const data = batches.data ?? [];

  return (
    <Card title="What has been brought in" subtitle="Every figure traces back to the file it came from.">
      {data.length === 0 ? (
        <EmptyState
          message="Nothing imported yet."
          hint="Your first import is usually a Tally export or a bank statement."
        />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-2xs uppercase tracking-wide text-ink-500">
            <tr>
              <th className="py-1.5 text-left font-normal">Reference</th>
              <th className="py-1.5 text-left font-normal">File</th>
              <th className="py-1.5 text-left font-normal">Kind</th>
              <th className="py-1.5 text-right font-normal">Rows</th>
              <th className="py-1.5 text-left font-normal">State</th>
              <th className="py-1.5 text-left font-normal">When</th>
            </tr>
          </thead>
          <tbody>
            {data.map((b) => (
              <tr key={b.id} className="border-t border-ink-850">
                <td className="py-1.5"><RecordCode code={b.recordCode} /></td>
                <td className="py-1.5 text-ink-200">
                  {b.fileName}
                  {b.sourceLabel && <span className="text-ink-500"> · {b.sourceLabel}</span>}
                </td>
                <td className="py-1.5 text-ink-300">{KIND_LABEL[b.kind] ?? b.kind}</td>
                <td className="py-1.5 text-right tabular-nums text-ink-300">{String(b.stats?.total ?? '—')}</td>
                <td className="py-1.5">
                  <StatusChip
                    status={b.status}
                    tone={b.status === 'committed' ? 'good' : b.status === 'reverted' ? 'bad' : 'neutral'}
                  />
                </td>
                <td className="py-1.5 text-ink-400">{relative(b.committedAt ?? b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
