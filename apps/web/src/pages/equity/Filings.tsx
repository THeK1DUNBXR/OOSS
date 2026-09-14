/**
 * Filings — statutory exports, the filing log, and demat status
 * (equity-portal plan §6 phase 6a).
 *
 * Downloads go through `api.download` rather than an `<a href>`, the same
 * discipline the SH-6 register already keeps in `Esop.tsx`. The filing log
 * is a record of what has been filed, not a second compliance calendar — the
 * calendar itself lives in Exceptions, and recording a filing here closes
 * the matching item there.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEMAT_STATUS_LABELS, FILING_FORMS, FILING_FORM_LABELS, FILING_STATUSES,
  type FilingForm, type FilingStatus, type FilingView, type FundingRoundView,
  type Pas6View, type ShareClassView, type ShareTransactionView,
} from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

interface CompanyProfileLite {
  dematStatus: 'physical' | 'demat' | 'mixed';
  isin: string | null;
  rtaName: string | null;
  isSmallCompany: boolean | null;
}

interface ExceptionLite {
  id: string;
  code: string;
  label: string;
  detail: string | null;
  state: string;
}

function useCompanyProfile() {
  return useQuery({ queryKey: ['company-profile'], queryFn: () => api.get<CompanyProfileLite>('/books/company-profile') });
}

function useEqtExceptions() {
  return useQuery({
    queryKey: ['exceptions', 'eqt', 'demat'],
    queryFn: () => api.get<ExceptionLite[]>('/command/exceptions?domain=eqt'),
  });
}

function useShareClasses() {
  return useQuery({ queryKey: ['equity-share-classes'], queryFn: () => api.get<{ items: ShareClassView[] }>('/equity/share-classes') });
}

function useRounds() {
  return useQuery({ queryKey: ['equity-rounds', 'picker'], queryFn: () => api.get<{ items: FundingRoundView[] }>('/equity/rounds') });
}

function useTransfers() {
  return useQuery({
    queryKey: ['equity-ledger', 'transfers'],
    queryFn: () => api.get<{ items: ShareTransactionView[] }>('/equity/ledger'),
    select: (d) => ({ items: d.items.filter((t) => t.type === 'transfer') }),
  });
}

function useFilingLog() {
  return useQuery({ queryKey: ['equity-filings-log'], queryFn: () => api.get<{ items: FilingView[] }>('/equity/filings/log') });
}

function DematPanel() {
  const { data: profile, isLoading } = useCompanyProfile();
  const { data: exceptions } = useEqtExceptions();
  const demat = exceptions?.filter((e) => ['EX-EQT-001', 'EX-EQT-004', 'EX-EQT-005'].includes(e.code) && e.state !== 'resolved') ?? [];

  return (
    <Card title="Demat" subtitle="Rule 9B: dematerialisation and the depository registration.">
      {isLoading || !profile ? (
        <Loading />
      ) : (
        <dl>
          <div className="flex justify-between border-b border-ink-800 py-1.5 text-xs">
            <dt className="text-ink-500">Status</dt>
            <dd className="text-ink-100">{DEMAT_STATUS_LABELS[profile.dematStatus]}</dd>
          </div>
          <div className="flex justify-between border-b border-ink-800 py-1.5 text-xs">
            <dt className="text-ink-500">ISIN</dt>
            <dd className="text-ink-100">{profile.isin || 'Not recorded'}</dd>
          </div>
          <div className="flex justify-between py-1.5 text-xs">
            <dt className="text-ink-500">RTA</dt>
            <dd className="text-ink-100">{profile.rtaName || 'Not recorded'}</dd>
          </div>
        </dl>
      )}
      {demat.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {demat.map((e) => (
            <p key={e.id} className="rounded-md border border-band-watch/40 bg-band-watch/10 px-3 py-2 text-2xs text-ink-200">
              {e.detail ?? e.label}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

function RecordFiling({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<FilingForm>('other');
  const [periodOrEvent, setPeriodOrEvent] = useState('');
  const [srn, setSrn] = useState('');
  const [filedOn, setFiledOn] = useState('');
  const [status, setStatus] = useState<FilingStatus>('filed');
  const [note, setNote] = useState('');

  return (
    <CreateModal
      open={open}
      title="Record a filing"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['equity-filings-log']]}
      onSubmit={() =>
        api.post('/equity/filings/log', {
          form,
          periodOrEvent,
          srn: srn || null,
          filedOn: filedOn || null,
          status,
          note: note || null,
        })
      }
    >
      <Row>
        <SelectInput
          label="Form"
          required
          value={form}
          onChange={(v) => setForm(v as FilingForm)}
          options={FILING_FORMS.map((f) => ({ value: f, label: FILING_FORM_LABELS[f] }))}
        />
        <SelectInput
          label="Status"
          required
          value={status}
          onChange={(v) => setStatus(v as FilingStatus)}
          options={FILING_STATUSES.map((s) => ({ value: s, label: s === 'due' ? 'Due' : s === 'filed' ? 'Filed' : 'Not required' }))}
        />
      </Row>
      <TextInput label="Period or event" required value={periodOrEvent} onChange={setPeriodOrEvent} placeholder="H1 2026-27, or the round/transaction it was for" />
      <Row>
        <TextInput label="SRN" value={srn} onChange={setSrn} placeholder="Optional" />
        <TextInput label="Filed on" type="date" value={filedOn} onChange={setFiledOn} />
      </Row>
      <TextInput label="Note" value={note} onChange={setNote} placeholder="Optional" />
      <p className="text-2xs text-ink-500">
        Filing a form this platform raised a compliance item for — PAS-3, FC-GPR, FC-TRS, FLA, PAS-6 — closes that item.
      </p>
    </CreateModal>
  );
}

function StatutoryForms() {
  const { data: classes } = useShareClasses();
  const { data: rounds } = useRounds();
  const { data: transfers } = useTransfers();
  const { data: profile } = useCompanyProfile();
  const { can } = useSession();
  const [pickingSh4, setPickingSh4] = useState(false);
  const [sh4Choice, setSh4Choice] = useState('');

  const equityClasses = (classes?.items ?? []).filter((c) => c.kind !== 'debenture');
  const debentureClasses = (classes?.items ?? []).filter((c) => c.kind === 'debenture');

  if (!can('compliance:X')) return null;

  return (
    <Card title="Statutory forms" subtitle="Downloaded in the layout the form wants.">
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">MGT-1 — register of members</p>
          {equityClasses.length === 0 ? (
            <p className="text-2xs text-ink-500">No equity or preference class is set up yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {equityClasses.map((c) => (
                <button key={c.id} className="btn-ghost" onClick={() => api.download(`/equity/filings/mgt-1.xlsx?shareClassId=${c.id}`, `mgt-1-${c.name}.xlsx`)}>
                  {c.name}
                </button>
              ))}
              <button className="btn-ghost" onClick={() => api.download('/equity/filings/mgt-1.xlsx', 'mgt-1-register.xlsx')}>
                All classes
              </button>
            </div>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">MGT-2 — register of debenture holders</p>
          {debentureClasses.length === 0 ? (
            <p className="text-2xs text-ink-500">No debenture class is set up yet.</p>
          ) : (
            <button className="btn-ghost" onClick={() => api.download('/equity/filings/mgt-2.xlsx', 'mgt-2-register.xlsx')}>
              Download
            </button>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">PAS-3 — allottee list, per round</p>
          {(rounds?.items ?? []).length === 0 ? (
            <p className="text-2xs text-ink-500">No round is on record yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(rounds?.items ?? []).map((r) => (
                <button key={r.id} className="btn-ghost" onClick={() => api.download(`/equity/filings/pas-3.xlsx?roundId=${r.id}`, `pas-3-${r.name}.xlsx`)}>
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-500">SH-4 — transfer pre-fill</p>
          {(transfers?.items ?? []).length === 0 ? (
            <p className="text-2xs text-ink-500">No transfer is on record yet.</p>
          ) : pickingSh4 ? (
            <Row>
              <SelectInput
                label="Transfer"
                value={sh4Choice}
                onChange={setSh4Choice}
                placeholder="Choose a transfer"
                options={(transfers?.items ?? []).map((t) => ({ value: t.id, label: `${t.recordCode} — ${t.count.toLocaleString('en-IN')} shares` }))}
              />
              <a
                className="btn-ghost self-end"
                href={sh4Choice ? `/equity/filings/sh-4/${sh4Choice}` : undefined}
                aria-disabled={!sh4Choice}
              >
                Open sheet
              </a>
            </Row>
          ) : (
            <button className="btn-ghost" onClick={() => setPickingSh4(true)}>
              Choose a transfer
            </button>
          )}
        </div>

        {profile && profile.dematStatus !== 'physical' && (
          <p className="text-2xs text-ink-500">PAS-6 reconciliation figures are below.</p>
        )}
      </div>
    </Card>
  );
}

function Pas6Panel() {
  const { data: profile } = useCompanyProfile();
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-pas6'],
    queryFn: () => api.get<Pas6View>('/equity/filings/pas-6.json'),
    enabled: Boolean(profile && profile.dematStatus !== 'physical'),
  });

  if (!profile || profile.dematStatus === 'physical') return null;
  if (error) return <ErrorBox error={error} />;

  return (
    <Card title="PAS-6 reconciliation" subtitle="Issued capital against demat and physical holdings, by class.">
      {isLoading || !data ? (
        <Loading />
      ) : data.classes.length === 0 ? (
        <EmptyState message="No equity or preference class carries any issued shares yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th className="text-right">Issued</th>
                <th className="text-right">Demat</th>
                <th className="text-right">Physical</th>
                <th className="text-right">Difference</th>
              </tr>
            </thead>
            <tbody>
              {data.classes.map((c) => (
                <tr key={c.shareClassId}>
                  <td>{c.shareClassName}</td>
                  <td className="text-right tabular-nums">{c.issuedCount.toLocaleString('en-IN')}</td>
                  <td className="text-right tabular-nums">{c.dematCount.toLocaleString('en-IN')}</td>
                  <td className="text-right tabular-nums">{c.physicalCount.toLocaleString('en-IN')}</td>
                  <td className="text-right tabular-nums">{c.difference === 0 ? '—' : c.difference.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FilingLog() {
  const { can } = useSession();
  const [recording, setRecording] = useState(false);
  const { data, isLoading, error } = useFilingLog();

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];

  return (
    <Card
      title="Filing log"
      subtitle="What has been filed, and what is still due."
      actions={can('compliance:C') && <NewButton label="Record filing" onClick={() => setRecording(true)} />}
    >
      <RecordFiling open={recording} onClose={() => setRecording(false)} />
      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState message="No filing has been recorded yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Form</th>
                <th>Period / event</th>
                <th>SRN</th>
                <th>Filed on</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{FILING_FORM_LABELS[f.form]}</td>
                  <td className="text-ink-300">{f.periodOrEvent}</td>
                  <td className="mono text-2xs">{f.srn || '—'}</td>
                  <td className="text-ink-300">{f.filedOn ? date(f.filedOn) : '—'}</td>
                  <td>
                    <StatusChip status={f.status} tone={f.status === 'filed' ? 'good' : f.status === 'due' ? 'warn' : 'neutral'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Filings() {
  return (
    <div>
      <PageHeader title="Filings" subtitle="Statutory exports, demat and FEMA, and what has been filed." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <StatutoryForms />
          <Pas6Panel />
          <FilingLog />
        </div>
        <div>
          <DematPanel />
        </div>
      </div>
    </div>
  );
}

