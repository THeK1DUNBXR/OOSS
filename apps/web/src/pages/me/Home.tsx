/**
 * My home — announcements, kudos, open cases, pending acknowledgements and
 * surveys waiting to be answered (docs/hcm/engagement.md).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, SelectInput, TextArea, TextInput } from '../../components/forms.js';

interface Announcement {
  id: string;
  recordCode: string;
  title: string;
  body: string;
  pinned: boolean;
  acknowledgementRequired: boolean;
  publishAt: string;
}

interface Recognition {
  id: string;
  fromPartyId: string;
  badge: string;
  message: string;
  points: number;
  createdAt: string;
}

interface HrCase {
  id: string;
  recordCode: string;
  category: string;
  status: string;
  subject: string;
  slaDueAt: string;
}

interface PolicyDocument {
  id: string;
  title: string;
  version: string;
}

interface SurveyQuestion {
  id: string;
  type: 'scale' | 'text' | 'enps';
  text: string;
  scaleMax?: number;
}

interface PulseSurvey {
  id: string;
  title: string;
  closesAt: string;
  questions: SurveyQuestion[];
}

interface HomeData {
  announcements: Announcement[];
  kudos: Recognition[];
  openCases: HrCase[];
  pendingAcknowledgements: { announcements: Announcement[]; policies: PolicyDocument[] };
  surveysToAnswer: PulseSurvey[];
}

export function Home() {
  const qc = useQueryClient();
  const [answering, setAnswering] = useState<PulseSurvey | null>(null);
  const home = useQuery({ queryKey: ['me-home'], queryFn: () => api.get<HomeData>('/hcm/engagement/me/home') });

  const ackAnnouncement = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/announcements/${id}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-home'] }),
  });
  const ackPolicy = useMutation({
    mutationFn: (id: string) => api.post(`/hcm/engagement/policies/${id}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-home'] }),
  });

  return (
    <div>
      <PageHeader title="My home" subtitle="What needs your attention, and what's landed for you recently." />
      {home.isLoading && <Loading />}
      {home.error && <ErrorBox error={home.error} />}
      {home.data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Pending acknowledgements">
            {home.data.pendingAcknowledgements.announcements.length === 0 && home.data.pendingAcknowledgements.policies.length === 0 ? (
              <EmptyState message="Nothing waiting on you." />
            ) : (
              <ul className="flex flex-col gap-2">
                {home.data.pendingAcknowledgements.announcements.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded border border-ink-800 p-2">
                    <div>
                      <p className="text-xs font-medium text-ink-100">{a.title}</p>
                      <p className="text-2xs text-ink-500">Announcement · {dateTime(a.publishAt)}</p>
                    </div>
                    <button className="btn text-2xs" disabled={ackAnnouncement.isPending} onClick={() => ackAnnouncement.mutate(a.id)}>
                      Acknowledge
                    </button>
                  </li>
                ))}
                {home.data.pendingAcknowledgements.policies.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-ink-800 p-2">
                    <div>
                      <p className="text-xs font-medium text-ink-100">{p.title}</p>
                      <p className="text-2xs text-ink-500">Policy v{p.version}</p>
                    </div>
                    <button className="btn text-2xs" disabled={ackPolicy.isPending} onClick={() => ackPolicy.mutate(p.id)}>
                      Acknowledge
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Surveys to answer">
            {home.data.surveysToAnswer.length === 0 ? (
              <EmptyState message="No open surveys are waiting on you." />
            ) : (
              <ul className="flex flex-col gap-2">
                {home.data.surveysToAnswer.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 rounded border border-ink-800 p-2">
                    <div>
                      <p className="text-xs font-medium text-ink-100">{s.title}</p>
                      <p className="text-2xs text-ink-500">Closes {dateTime(s.closesAt)}</p>
                    </div>
                    <button className="btn text-2xs" onClick={() => setAnswering(s)}>
                      Answer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="My open cases">
            {home.data.openCases.length === 0 ? (
              <EmptyState message="No open helpdesk cases." />
            ) : (
              <ul className="flex flex-col gap-2">
                {home.data.openCases.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-ink-800 p-2">
                    <div>
                      <p className="text-xs font-medium text-ink-100">{c.subject}</p>
                      <p className="text-2xs text-ink-500 mono">{c.recordCode} · {c.category.replace(/_/g, ' ')}</p>
                    </div>
                    <StatusChip status={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Kudos received">
            {home.data.kudos.length === 0 ? (
              <EmptyState message="No kudos yet." hint="Recognition given by a colleague will show up here." />
            ) : (
              <ul className="flex flex-col gap-2">
                {home.data.kudos.map((k) => (
                  <li key={k.id} className="rounded border border-ink-800 p-2">
                    <p className="text-xs font-medium text-ink-100">{k.badge}</p>
                    <p className="text-2xs text-ink-400">{k.message}</p>
                    <p className="text-2xs text-ink-500">{dateTime(k.createdAt)} · {k.points} pts</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Announcements" className="lg:col-span-2">
            {home.data.announcements.length === 0 ? (
              <EmptyState message="No announcements right now." />
            ) : (
              <ul className="flex flex-col gap-2">
                {home.data.announcements.map((a) => (
                  <li key={a.id} className="rounded border border-ink-800 p-2">
                    <div className="flex items-center gap-2">
                      {a.pinned && <span className="chip border-accent/40 bg-accent/10 text-accent-soft">Pinned</span>}
                      <p className="text-xs font-medium text-ink-100">{a.title}</p>
                    </div>
                    <p className="mt-1 text-2xs text-ink-400">{a.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      {answering && <AnswerSurveyModal survey={answering} onClose={() => setAnswering(null)} />}
    </div>
  );
}

function AnswerSurveyModal({ survey, onClose }: { survey: PulseSurvey; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <CreateModal
      open
      title={survey.title}
      submitLabel="Submit"
      onClose={onClose}
      invalidate={[['me-home']]}
      onSubmit={() =>
        api.post(`/hcm/engagement/surveys/${survey.id}/responses`, {
          answers: survey.questions.map((q) => ({
            questionId: q.id,
            value: q.type === 'text' ? values[q.id] ?? '' : Number(values[q.id] ?? 0),
          })),
        })
      }
    >
      {survey.questions.map((q) =>
        q.type === 'text' ? (
          <TextArea
            key={q.id}
            label={q.text}
            value={values[q.id] ?? ''}
            onChange={(v) => setValues({ ...values, [q.id]: v })}
            required
          />
        ) : (
          <SelectInput
            key={q.id}
            label={q.text}
            value={values[q.id] ?? ''}
            onChange={(v) => setValues({ ...values, [q.id]: v })}
            options={Array.from({ length: (q.type === 'enps' ? 10 : q.scaleMax ?? 10) + 1 }, (_, n) => ({
              value: String(n),
              label: String(n),
            }))}
          />
        ),
      )}
    </CreateModal>
  );
}
