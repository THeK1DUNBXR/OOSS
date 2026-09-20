/**
 * My requests (docs/hcm/assets.md).
 *
 * Self-service: the assets I currently hold, my travel requests (submit and
 * track), and my letter requests (submit and track). Everything here resolves
 * against my own employment relationship — there is no id field to type in.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextArea, TextInput } from '../../components/forms.js';

type Tab = 'assets' | 'travel' | 'letters';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'assets', label: 'My assets' },
  { key: 'travel', label: 'Travel' },
  { key: 'letters', label: 'Letters' },
];

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  submitted: 'accent',
  approved: 'good',
  rejected: 'bad',
  settled: 'good',
  requested: 'accent',
  fulfilled: 'good',
};

interface MyEmployment {
  id: string;
  status: string;
}

export function Requests() {
  const [tab, setTab] = useState<Tab>('assets');
  const employment = useQuery({
    queryKey: ['me-employment'],
    queryFn: () => api.get<MyEmployment>('/hcm/assets/me/employment'),
    retry: false,
  });

  return (
    <>
      <PageHeader
        title="My requests"
        subtitle="What I currently hold, and what I have asked HR for — travel and letters. Approvals and fulfilment happen on People → Assets, by someone other than me."
      />
      {employment.isLoading && <Loading />}
      {employment.isError && (
        <Card>
          <EmptyState
            message="No employment relationship is on file for your account yet."
            hint="Travel and letter requests need an active employment record — ask HR to check your record if you expect one."
          />
        </Card>
      )}
      {employment.data && (
        <>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === 'assets' && <MyAssetsTab employmentId={employment.data.id} />}
          {tab === 'travel' && <MyTravelTab employmentId={employment.data.id} />}
          {tab === 'letters' && <MyLettersTab employmentId={employment.data.id} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// My assets
// ---------------------------------------------------------------------------

interface AssetAssignment {
  id: string;
  issuedOn: string;
  returnedOn: string | null;
  condition: string;
  asset: { tag: string; category: string };
}

function MyAssetsTab({ employmentId }: { employmentId: string }) {
  const assignments = useQuery({
    queryKey: ['me-assignments', employmentId],
    queryFn: () => api.get<AssetAssignment[]>(`/hcm/assets/assignments?employmentId=${employmentId}`),
  });
  const current = (assignments.data ?? []).filter((a) => !a.returnedOn);
  const past = (assignments.data ?? []).filter((a) => a.returnedOn);

  return (
    <Card title="Assets I hold" subtitle="Issued to me and not yet returned.">
      {assignments.isLoading && <Loading />}
      {assignments.error && <ErrorBox error={assignments.error} />}
      {assignments.data && current.length === 0 && <EmptyState message="Nothing is currently issued to you." />}
      {current.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Category</th>
              <th>Issued</th>
            </tr>
          </thead>
          <tbody>
            {current.map((a) => (
              <tr key={a.id}>
                <td className="font-mono text-2xs">{a.asset.tag}</td>
                <td>{a.asset.category.replace(/_/g, ' ')}</td>
                <td>{date(a.issuedOn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {past.length > 0 && (
        <>
          <p className="mt-4 mb-1 text-2xs uppercase tracking-wide text-ink-500">Previously held</p>
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Issued</th>
                <th>Returned</th>
                <th>Condition on return</th>
              </tr>
            </thead>
            <tbody>
              {past.map((a) => (
                <tr key={a.id}>
                  <td className="font-mono text-2xs">{a.asset.tag}</td>
                  <td>{date(a.issuedOn)}</td>
                  <td>{date(a.returnedOn!)}</td>
                  <td>{a.condition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

interface TravelRequest {
  id: string;
  recordCode: string;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  startDate: string;
  endDate: string;
  mode: string;
  estimatedCost: number | null;
  status: string;
}

function MyTravelTab({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    purpose: '', fromLocation: '', toLocation: '', startDate: '', endDate: '',
    mode: 'flight' as 'flight' | 'train' | 'road' | 'other', estimatedCost: '', advanceRequested: '',
  });

  const requests = useQuery({
    queryKey: ['me-travel', employmentId],
    queryFn: () => api.get<TravelRequest[]>(`/hcm/assets/travel?employmentId=${employmentId}`),
  });

  return (
    <Card
      title="My travel requests"
      subtitle="Someone other than you decides these — the Self-Dealing Bar means you can never approve your own."
      actions={<NewButton label="Request travel" onClick={() => setOpen(true)} />}
    >
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="You have not requested travel yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Route</th>
              <th>Dates</th>
              <th>Est. cost</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-2xs">{r.recordCode}</td>
                <td>
                  {r.fromLocation} → {r.toLocation}
                  <p className="text-2xs text-ink-500">{r.purpose}</p>
                </td>
                <td>{date(r.startDate)} – {date(r.endDate)}</td>
                <td>{r.estimatedCost === null ? '—' : `₹${r.estimatedCost.toLocaleString('en-IN')}`}</td>
                <td><StatusChip status={r.status} tone={STATUS_TONE[r.status]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateModal
        open={open}
        title="Request travel"
        onClose={() => setOpen(false)}
        invalidate={[['me-travel', employmentId]]}
        onSubmit={() =>
          api.post('/hcm/assets/travel', {
            employmentRelationshipId: employmentId,
            purpose: form.purpose,
            fromLocation: form.fromLocation,
            toLocation: form.toLocation,
            startDate: form.startDate,
            endDate: form.endDate,
            mode: form.mode,
            estimatedCost: Number(form.estimatedCost),
            advanceRequested: form.advanceRequested ? Number(form.advanceRequested) : undefined,
          })
        }
      >
        <TextInput label="Purpose" value={form.purpose} onChange={(v) => setForm({ ...form, purpose: v })} required />
        <Row>
          <TextInput label="From" value={form.fromLocation} onChange={(v) => setForm({ ...form, fromLocation: v })} required />
          <TextInput label="To" value={form.toLocation} onChange={(v) => setForm({ ...form, toLocation: v })} required />
        </Row>
        <Row>
          <TextInput label="Departure" type="date" value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} required />
          <TextInput label="Return" type="date" value={form.endDate} onChange={(v) => setForm({ ...form, endDate: v })} required />
        </Row>
        <SelectInput
          label="Mode"
          value={form.mode}
          onChange={(v) => setForm({ ...form, mode: v as typeof form.mode })}
          options={[
            { value: 'flight', label: 'Flight' },
            { value: 'train', label: 'Train' },
            { value: 'road', label: 'Road' },
            { value: 'other', label: 'Other' },
          ]}
        />
        <Row>
          <TextInput label="Estimated cost" type="number" value={form.estimatedCost} onChange={(v) => setForm({ ...form, estimatedCost: v })} required hint="₹" />
          <TextInput label="Advance requested" type="number" value={form.advanceRequested} onChange={(v) => setForm({ ...form, advanceRequested: v })} hint="₹, optional" />
        </Row>
      </CreateModal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

interface LetterRequest {
  id: string;
  kind: string;
  status: string;
  number: string | null;
  snapshot: { body: string } | null;
  decisionNote: string | null;
}

const LETTER_KIND_OPTIONS = [
  { value: 'address_proof', label: 'Address proof' },
  { value: 'salary_certificate', label: 'Salary certificate' },
  { value: 'noc', label: 'No-objection certificate' },
  { value: 'visa', label: 'Visa letter' },
  { value: 'experience', label: 'Experience certificate' },
];

function MyLettersTab({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof LETTER_KIND_OPTIONS)[number]['value']>('salary_certificate');
  const [note, setNote] = useState('');
  const [viewing, setViewing] = useState<LetterRequest | null>(null);

  const requests = useQuery({
    queryKey: ['me-letters', employmentId],
    queryFn: () => api.get<LetterRequest[]>(`/hcm/assets/letters?employmentId=${employmentId}`),
  });

  return (
    <Card
      title="My letter requests"
      subtitle="Address proof, salary certificate, NOC, visa or experience letters — HR fulfils these from People → Assets."
      actions={<NewButton label="Request a letter" onClick={() => { setKind('salary_certificate'); setNote(''); setOpen(true); }} />}
    >
      {requests.isLoading && <Loading />}
      {requests.error && <ErrorBox error={requests.error} />}
      {requests.data && requests.data.length === 0 && <EmptyState message="You have not requested a letter yet." />}
      {requests.data && requests.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Status</th>
              <th>Number</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td>{r.kind.replace(/_/g, ' ')}</td>
                <td>
                  <StatusChip status={r.status} tone={STATUS_TONE[r.status]} />
                  {r.status === 'rejected' && r.decisionNote && <p className="mt-0.5 text-2xs text-ink-500">{r.decisionNote}</p>}
                </td>
                <td className="font-mono text-2xs">{r.number ?? '—'}</td>
                <td className="text-right">
                  {r.status === 'fulfilled' && r.snapshot && (
                    <button className="btn text-2xs" onClick={() => setViewing(r)}>
                      View
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {viewing?.snapshot && (
        <div className="mt-4 rounded border border-ink-700 bg-ink-900 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs uppercase tracking-wide text-ink-500">{viewing.number}</span>
            <button className="btn text-2xs" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-ink-200">{viewing.snapshot.body}</pre>
        </div>
      )}

      <CreateModal
        open={open}
        title="Request a letter"
        onClose={() => setOpen(false)}
        invalidate={[['me-letters', employmentId]]}
        onSubmit={() => api.post('/hcm/assets/letters', { employmentRelationshipId: employmentId, kind, note: note || undefined })}
      >
        <SelectInput label="Kind" value={kind} onChange={setKind} options={LETTER_KIND_OPTIONS} />
        <TextArea label="Note (optional)" value={note} onChange={setNote} />
      </CreateModal>
    </Card>
  );
}
