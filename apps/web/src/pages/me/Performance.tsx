/**
 * My performance — WS5 (docs/hcm/performance.md).
 *
 * The self-service half: reviews assigned to me to fill in, my released
 * ratings (nothing shows here before the cycle closes and HR releases the
 * row — that is not a bug, it is the rule), feedback I have given and
 * received, my 1:1s and any PIP against me.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, titleCase } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextArea } from '../../components/forms.js';

type Tab = 'reviews' | 'ratings' | 'feedback' | 'oneOnOnes' | 'pips';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'reviews', label: 'My reviews' },
  { key: 'ratings', label: 'My ratings' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'oneOnOnes', label: 'My 1:1s' },
  { key: 'pips', label: 'My PIP' },
];

interface MyContext {
  employmentRelationshipId: string | null;
}

function useMyContext() {
  return useQuery({ queryKey: ['performance-my-context'], queryFn: () => api.get<MyContext>('/hcm/performance/my/context') });
}

export function Performance() {
  const [tab, setTab] = useState<Tab>('reviews');
  const ctx = useMyContext();

  return (
    <>
      <PageHeader title="My performance" subtitle="Your reviews, your released ratings, feedback, 1:1s and any improvement plan against you." />
      {ctx.isLoading && <Loading />}
      {!ctx.isLoading && !ctx.data?.employmentRelationshipId && (
        <Card>
          <EmptyState message="No active employment relationship is linked to your account." hint="Ask HR to confirm your employee record." />
        </Card>
      )}
      {ctx.data?.employmentRelationshipId && (
        <>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === 'reviews' && <MyReviewsTab employmentId={ctx.data.employmentRelationshipId} />}
          {tab === 'ratings' && <MyRatingsTab employmentId={ctx.data.employmentRelationshipId} />}
          {tab === 'feedback' && <FeedbackTab employmentId={ctx.data.employmentRelationshipId} />}
          {tab === 'oneOnOnes' && <OneOnOnesTab employmentId={ctx.data.employmentRelationshipId} />}
          {tab === 'pips' && <PipsTab employmentId={ctx.data.employmentRelationshipId} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reviews I owe
// ---------------------------------------------------------------------------

interface ReviewAssignment {
  id: string;
  employmentRelationshipId: string;
  kind: string;
  status: string;
  response: { comments: string | null } | null;
}

function MyReviewsTab({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [score, setScore] = useState('3');
  const [comments, setComments] = useState('');

  const assignments = useQuery({
    queryKey: ['my-review-assignments'],
    queryFn: () => api.get<ReviewAssignment[]>('/hcm/performance/review-assignments?mine=true'),
  });

  const submit = useMutation({
    mutationFn: (id: string) =>
      api.post(`/hcm/performance/review-assignments/${id}/submit`, {
        ratings: [{ sectionKey: 'overall', score: Number(score) }],
        comments,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-review-assignments'] });
      setOpenId(null);
      setComments('');
      setScore('3');
    },
  });

  const pending = (assignments.data ?? []).filter((a) => a.status === 'pending');
  const submitted = (assignments.data ?? []).filter((a) => a.status === 'submitted');

  return (
    <>
      <Card title="Reviews to complete" subtitle="Includes your own self-review and anyone you have been asked to review.">
        {assignments.isLoading && <Loading />}
        {assignments.error && <ErrorBox error={assignments.error} />}
        {pending.length === 0 && !assignments.isLoading && <EmptyState message="Nothing waiting on you right now." />}
        {pending.length > 0 && (
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded border border-ink-800 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-ink-100">
                    {a.kind === 'self' && a.employmentRelationshipId === employmentId ? 'Your self-review' : `A ${a.kind} review`}
                  </span>
                  <button className="btn text-2xs" onClick={() => setOpenId(a.id)}>
                    Fill in
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Submitted" className="mt-4">
        {submitted.length === 0 && <EmptyState message="Nothing submitted yet." />}
        {submitted.length > 0 && (
          <ul className="space-y-1">
            {submitted.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm text-ink-300">
                <span>{titleCase(a.kind)} review</span>
                <StatusChip status="submitted" tone="good" />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateModal
        open={!!openId}
        title="Fill in this review"
        onClose={() => setOpenId(null)}
        invalidate={[['my-review-assignments']]}
        onSubmit={() => submit.mutateAsync(openId!)}
      >
        <SelectInput
          label="Overall rating"
          value={score as never}
          onChange={setScore}
          options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))}
          required
        />
        <TextArea label="Comments" value={comments} onChange={setComments} required />
      </CreateModal>
    </>
  );
}

// ---------------------------------------------------------------------------
// My ratings
// ---------------------------------------------------------------------------

interface FinalRating {
  id: string;
  cycleId: string;
  rating: string | null;
  band: string | null;
  potential: string | null;
  promotionRecommended: boolean;
  releasedAt: string | null;
}

function MyRatingsTab({ employmentId }: { employmentId: string }) {
  const ratings = useQuery({
    queryKey: ['my-final-ratings', employmentId],
    queryFn: () => api.get<FinalRating[]>(`/hcm/performance/final-ratings?employmentRelationshipId=${employmentId}`),
  });

  return (
    <Card title="My ratings" subtitle="A rating appears here once its cycle is closed and HR has released it — not before.">
      {ratings.isLoading && <Loading />}
      {ratings.error && <ErrorBox error={ratings.error} />}
      {ratings.data && ratings.data.length === 0 && <EmptyState message="No released rating yet." hint="It will appear here once your cycle closes and HR releases it." />}
      {ratings.data && ratings.data.length > 0 && (
        <ul className="space-y-2">
          {ratings.data.map((r) => (
            <li key={r.id} className="rounded border border-ink-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-lg font-semibold text-ink-50">{r.rating}</span>
                {r.promotionRecommended && <StatusChip status="promotion recommended" tone="good" />}
              </div>
              <p className="mt-1 text-2xs text-ink-500">Band {r.band ?? '—'} · Potential {titleCase(r.potential)} · Released {date(r.releasedAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

interface FeedbackRow {
  id: string;
  fromEmploymentRelationshipId: string;
  toEmploymentRelationshipId: string;
  kind: string;
  message: string;
  createdAt: string;
}

function FeedbackTab({ employmentId }: { employmentId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ toEmploymentRelationshipId: '', kind: 'praise' as string, message: '' });

  const feedback = useQuery({ queryKey: ['my-feedback'], queryFn: () => api.get<FeedbackRow[]>('/hcm/performance/feedback') });

  const received = (feedback.data ?? []).filter((f) => f.toEmploymentRelationshipId === employmentId);
  const given = (feedback.data ?? []).filter((f) => f.fromEmploymentRelationshipId === employmentId);

  return (
    <>
      <Card title="Received" actions={<button className="btn-primary text-xs" onClick={() => setOpen(true)}>Give feedback</button>}>
        {feedback.isLoading && <Loading />}
        {feedback.error && <ErrorBox error={feedback.error} />}
        {received.length === 0 && !feedback.isLoading && <EmptyState message="No feedback received yet." />}
        {received.length > 0 && (
          <ul className="space-y-2">
            {received.map((f) => (
              <li key={f.id} className="rounded border border-ink-800 p-3">
                <div className="flex items-center justify-between">
                  <StatusChip status={f.kind} tone={f.kind === 'praise' ? 'good' : 'warn'} />
                  <span className="text-2xs text-ink-500">{date(f.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm text-ink-200">{f.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Given" className="mt-4">
        {given.length === 0 && <EmptyState message="You have not given feedback yet." />}
        {given.length > 0 && (
          <ul className="space-y-2">
            {given.map((f) => (
              <li key={f.id} className="text-sm text-ink-300">
                {f.message}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateModal
        open={open}
        title="Give feedback"
        onClose={() => setOpen(false)}
        invalidate={[['my-feedback']]}
        onSubmit={() =>
          api.post('/hcm/performance/feedback', {
            fromEmploymentRelationshipId: employmentId,
            toEmploymentRelationshipId: form.toEmploymentRelationshipId,
            kind: form.kind,
            message: form.message,
          })
        }
      >
        <Row>
          <label className="block">
            <span className="label mb-1 block">Colleague's employment id</span>
            <input
              className="input"
              value={form.toEmploymentRelationshipId}
              onChange={(e) => setForm({ ...form, toEmploymentRelationshipId: e.target.value })}
              placeholder="Ask HR or paste from the directory"
              required
            />
          </label>
          <SelectInput label="Kind" value={form.kind as never} onChange={(v) => setForm({ ...form, kind: v })} options={[{ value: 'praise', label: 'Praise' }, { value: 'constructive', label: 'Constructive' }]} required />
        </Row>
        <TextArea label="Message" value={form.message} onChange={(v) => setForm({ ...form, message: v })} required />
      </CreateModal>
    </>
  );
}

// ---------------------------------------------------------------------------
// 1:1s
// ---------------------------------------------------------------------------

interface OneOnOne {
  id: string;
  scheduledAt: string;
  status: string;
}

function OneOnOnesTab({ employmentId }: { employmentId: string }) {
  const oneOnOnes = useQuery({
    queryKey: ['my-1on1s', employmentId],
    queryFn: () => api.get<OneOnOne[]>(`/hcm/performance/one-on-ones?employmentRelationshipId=${employmentId}`),
  });

  return (
    <Card title="My 1:1s">
      {oneOnOnes.isLoading && <Loading />}
      {oneOnOnes.error && <ErrorBox error={oneOnOnes.error} />}
      {oneOnOnes.data && oneOnOnes.data.length === 0 && <EmptyState message="No 1:1s scheduled." />}
      {oneOnOnes.data && oneOnOnes.data.length > 0 && (
        <ul className="space-y-1">
          {oneOnOnes.data.map((o) => (
            <li key={o.id} className="flex items-center justify-between text-sm text-ink-200">
              <span>{date(o.scheduledAt)}</span>
              <StatusChip status={o.status} tone={o.status === 'completed' ? 'good' : 'neutral'} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// PIPs
// ---------------------------------------------------------------------------

interface PipRow {
  id: string;
  startsOn: string;
  endsOn: string;
  outcome: string;
}

const PIP_TONE: Record<string, 'neutral' | 'good' | 'bad' | 'warn'> = { open: 'warn', successful: 'good', extended: 'neutral', exited: 'bad' };

function PipsTab({ employmentId }: { employmentId: string }) {
  const pips = useQuery({
    queryKey: ['my-pips', employmentId],
    queryFn: () => api.get<PipRow[]>(`/hcm/performance/pips?employmentRelationshipId=${employmentId}`),
  });

  return (
    <Card title="My PIP" subtitle="Only shown if one is open or has been recorded against you.">
      {pips.isLoading && <Loading />}
      {pips.error && <ErrorBox error={pips.error} />}
      {pips.data && pips.data.length === 0 && <EmptyState message="No Performance Improvement Plan on your record." />}
      {pips.data && pips.data.length > 0 && (
        <ul className="space-y-2">
          {pips.data.map((p) => (
            <li key={p.id} className="rounded border border-ink-800 p-3">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-ink-400">{date(p.startsOn)} – {date(p.endsOn)}</span>
                <StatusChip status={p.outcome} tone={PIP_TONE[p.outcome]} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
