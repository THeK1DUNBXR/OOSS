/**
 * Compliance calendar (docs/plan/compliance.md, workstream A).
 *
 * The spine every statutory deadline sits on: GSTR-1/3B, TDS, PF, ESI,
 * Tamil Nadu Professional Tax, advance tax, AOC-4/MGT-7/DIR-3 KYC, the POSH
 * annual report. A row is a due date waiting to be filed, not a date
 * somebody has to remember — the daily job keeps `upcoming` -> `due` ->
 * `overdue` current and raises an exception on the owner as a deadline
 * approaches and passes.
 *
 * Filing and waiving are the only two ways a row leaves `due`/`overdue`, and
 * both ask for something: filing asks for the portal's own acknowledgement
 * (an ARN, a challan number), waiving asks for a reason. Neither is a status
 * flip with nothing behind it.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
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
import { TextArea, TextInput, messageOf } from '../../components/forms.js';

type Domain = 'fin' | 'hr' | 'gov' | 'edu';
type Status = 'upcoming' | 'due' | 'filed' | 'overdue' | 'waived';

interface ObligationType {
  id: string;
  code: string;
  label: string;
  governingLaw: string;
  section: string | null;
  domain: Domain;
  ownerRoleSlug: string;
  evidenceRequired: boolean;
  note: string | null;
}

interface Obligation {
  id: string;
  recordCode: string | null;
  typeId: string;
  period: string;
  dueAt: string;
  status: Status;
  filedAt: string | null;
  reference: string | null;
  note: string | null;
  type: ObligationType;
}

interface Summary {
  notYetMeasured: boolean;
  byStatus: Record<Status, number>;
  byDomain: Record<Domain, number>;
  filedThisFy: number;
}

const DOMAIN_LABEL: Record<Domain, string> = { fin: 'Finance', hr: 'People', gov: 'Corporate', edu: 'Education' };
const STATUS_TONE: Record<Status, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  upcoming: 'neutral',
  due: 'accent',
  overdue: 'bad',
  filed: 'good',
  waived: 'warn',
};

const OWNER_ROLE_LABEL: Record<string, string> = {
  finance_head: 'Finance Head',
  hr_ops_manager: 'Operations Head',
  chairman: 'Chairman',
  employee: 'Employee',
};

function ownerLabel(slug: string): string {
  return OWNER_ROLE_LABEL[slug] ?? slug;
}

export function ComplianceCalendar() {
  const qc = useQueryClient();
  const [domain, setDomain] = useState<Domain | 'all'>('all');
  const [fileTarget, setFileTarget] = useState<Obligation | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<Obligation | null>(null);

  const summary = useQuery({
    queryKey: ['compliance-calendar-summary'],
    queryFn: () => api.get<Summary>('/compliance/calendar/summary'),
  });

  const obligations = useQuery({
    queryKey: ['compliance-calendar', domain],
    queryFn: () => api.get<Obligation[]>(`/compliance/calendar${domain === 'all' ? '' : `?domain=${domain}`}`),
  });

  const generate = useMutation({
    mutationFn: () => api.post('/compliance/calendar/generate'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compliance-calendar'] });
      qc.invalidateQueries({ queryKey: ['compliance-calendar-summary'] });
    },
  });

  const rows = useMemo(() => [...(obligations.data ?? [])].sort((a, b) => a.dueAt.localeCompare(b.dueAt)), [obligations.data]);

  if (obligations.error) return <ErrorBox error={obligations.error} />;

  const s = summary.data;

  return (
    <div>
      <PageHeader
        title="Compliance calendar"
        subtitle="Every statutory deadline the company holds, materialised ahead of time and chased by the daily job — GST, TDS, PF, ESI, Professional Tax, advance tax and the MCA filings."
        actions={
          <button className="btn" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? 'Generating…' : 'Generate upcoming'}
          </button>
        }
      />

      {generate.isError && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {messageOf(generate.error)}
        </p>
      )}

      {s?.notYetMeasured ? (
        <Card>
          <EmptyState
            message="No obligation types are set up yet."
            hint="This is unmeasured, not compliant — nothing has been checked. Seed the obligation types before this tenant can track deadlines."
          />
        </Card>
      ) : (
        s && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Due soon" value={s.byStatus.due} tone={s.byStatus.due > 0 ? 'warn' : 'neutral'} noActionReason="Within 30 days of the deadline." />
            <Metric label="Overdue" value={s.byStatus.overdue} tone={s.byStatus.overdue > 0 ? 'bad' : 'good'} noActionReason="Past the due date, not filed or waived." />
            <Metric label="Upcoming" value={s.byStatus.upcoming} noActionReason="More than 30 days out." />
            <Metric label="Filed this FY" value={s.filedThisFy} tone="good" noActionReason="Recorded with a reference from the portal." />
          </div>
        )
      )}

      <Tabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'fin', label: DOMAIN_LABEL.fin, count: s?.byDomain.fin },
          { key: 'hr', label: DOMAIN_LABEL.hr, count: s?.byDomain.hr },
          { key: 'gov', label: DOMAIN_LABEL.gov, count: s?.byDomain.gov },
          { key: 'edu', label: DOMAIN_LABEL.edu, count: s?.byDomain.edu },
        ]}
        active={domain}
        onChange={setDomain}
      />

      <Card>
        {obligations.isLoading ? (
          <Loading label="Loading the calendar" />
        ) : rows.length === 0 ? (
          <EmptyState
            message={domain === 'all' ? 'Nothing on the calendar yet.' : `Nothing on the calendar for ${DOMAIN_LABEL[domain]}.`}
            hint="Generate the upcoming obligations, or widen the filter."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3">Due</th>
                  <th className="py-2 pr-3">Obligation</th>
                  <th className="py-2 pr-3">Period</th>
                  <th className="py-2 pr-3">Owner</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Reference</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const actionable = row.status !== 'filed' && row.status !== 'waived';
                  return (
                    <tr key={row.id} className="border-b border-ink-850/60">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-ink-200">{date(row.dueAt)}</td>
                      <td className="py-2 pr-3">
                        <div className="text-ink-100">{row.type.label}</div>
                        <div className="text-2xs text-ink-500">
                          {row.type.governingLaw}
                          {row.type.section ? `, ${row.type.section}` : ''} · <RecordCode code={row.recordCode} />
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-ink-300">{row.period}</td>
                      <td className="py-2 pr-3 text-ink-300">{ownerLabel(row.type.ownerRoleSlug)}</td>
                      <td className="py-2 pr-3">
                        <StatusChip status={row.status} tone={STATUS_TONE[row.status]} />
                      </td>
                      <td className="py-2 pr-3 text-ink-300">{row.reference ?? '—'}</td>
                      <td className="py-2 pr-3 text-right">
                        {actionable && (
                          <div className="flex justify-end gap-2">
                            <button className="btn-sm" onClick={() => setFileTarget(row)}>
                              File
                            </button>
                            <button className="btn-sm" onClick={() => setWaiveTarget(row)}>
                              Waive
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 text-2xs italic text-ink-500">
        Prepares and tracks; filing happens on the portal — record the acknowledgement here.
      </p>

      {fileTarget && (
        <FileModal
          obligation={fileTarget}
          onClose={() => setFileTarget(null)}
          onFiled={() => {
            qc.invalidateQueries({ queryKey: ['compliance-calendar'] });
            qc.invalidateQueries({ queryKey: ['compliance-calendar-summary'] });
          }}
        />
      )}
      {waiveTarget && (
        <WaiveModal
          obligation={waiveTarget}
          onClose={() => setWaiveTarget(null)}
          onWaived={() => {
            qc.invalidateQueries({ queryKey: ['compliance-calendar'] });
            qc.invalidateQueries({ queryKey: ['compliance-calendar-summary'] });
          }}
        />
      )}
    </div>
  );
}

function FileModal({ obligation, onClose, onFiled }: { obligation: Obligation; onClose: () => void; onFiled: () => void }) {
  const [reference, setReference] = useState('');
  const [evidenceDocumentId, setEvidenceDocumentId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/compliance/calendar/${obligation.id}/file`, {
        reference,
        evidenceDocumentId: evidenceDocumentId || undefined,
        note: note || undefined,
      }),
    onSuccess: () => {
      onFiled();
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title={`File ${obligation.type.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="file-obligation-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Recording…' : 'Mark filed'}
          </button>
        </>
      }
    >
      <form
        id="file-obligation-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
        )}
        <Field label="Period">{obligation.period}</Field>
        <TextInput label="Reference" value={reference} onChange={setReference} required hint="ARN, challan, or acknowledgement number" />
        {obligation.type.evidenceRequired && (
          <TextInput
            label="Evidence document ID"
            value={evidenceDocumentId}
            onChange={setEvidenceDocumentId}
            required
            hint="Required for this obligation before it can be marked filed."
          />
        )}
        <TextArea label="Note" value={note} onChange={setNote} rows={2} />
      </form>
    </Modal>
  );
}

function WaiveModal({ obligation, onClose, onWaived }: { obligation: Obligation; onClose: () => void; onWaived: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/compliance/calendar/${obligation.id}/waive`, { reason }),
    onSuccess: () => {
      onWaived();
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <Modal
      open
      title={`Waive ${obligation.type.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="waive-obligation-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Recording…' : 'Waive'}
          </button>
        </>
      }
    >
      <form
        id="waive-obligation-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        {error && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
        )}
        <Field label="Period">{obligation.period}</Field>
        <TextArea label="Reason" value={reason} onChange={setReason} rows={3} required hint="A deliberate decision not to file, not a status you forget to come back to." />
      </form>
    </Modal>
  );
}
