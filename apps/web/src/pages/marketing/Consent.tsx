/**
 * Consent & preferences — one person's marketing standing.
 *
 * The `marketing` purpose code here is the same Consent domain
 * `compliance/privacy.ts` already owns (MKT-CON note in the skeleton): this
 * screen never invents a second consent record, it reads and writes the one
 * purpose-bound row that purpose already declares. Every send checks it
 * (MKT-CON-001) and a do-not-contact flag overrides everything else
 * (MKT-CON-002).
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CHANNEL_KEYS, CHANNEL_KEY_LABELS, type ChannelKey, type PreferenceChangeSource } from '@kaizen/shared';
import { api, dateTime, titleCase } from '../../lib/api.js';
import {
  Card,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
  Metric,
  PageHeader,
  RecordCode,
  StatusChip,
} from '../../components/ui.js';
import { messageOf } from '../../components/forms.js';
import {
  usePreferenceCoverage,
  usePreferences,
  useRecordConsent,
  useSetChannelPreference,
  useSetDoNotContact,
  useWithdrawConsent,
} from '../../lib/marketingApi.js';
import { useSession } from '../../lib/session.js';

interface PersonHit {
  id: string;
  recordCode: string;
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
}

const CONSENT_CHANNELS: Array<{ value: 'portal' | 'in_app' | 'paper' | 'verbal' | 'guardian_intake'; label: string }> = [
  { value: 'portal', label: 'Portal' },
  { value: 'in_app', label: 'In-app' },
  { value: 'paper', label: 'Paper form' },
  { value: 'verbal', label: 'Verbal, recorded by staff' },
  { value: 'guardian_intake', label: "Guardian intake" },
];

export function Consent() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [personId, setPersonId] = useState<string | null>(null);
  const [personLabel, setPersonLabel] = useState<string>('');

  const { data: search, isFetching } = useQuery({
    queryKey: ['mkt', 'consent-person-search', q],
    queryFn: () => api.get<{ items: PersonHit[] }>(`/crm/people?q=${encodeURIComponent(q)}&pageSize=10`),
    enabled: q.length >= 2,
  });

  const canSeeCoverage = can('marketing_analytics:V');
  const coverage = usePreferenceCoverage(canSeeCoverage);

  return (
    <div>
      <PageHeader
        title="Consent & preferences"
        subtitle="Marketing consent, channel opt-ins, and do-not-contact — for one person at a time."
      />

      {canSeeCoverage && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <CoverageMetric
            label="People contacted"
            value={coverage.data?.contacted}
            measured={coverage.data?.measured ?? false}
            noActionReason="Everyone who has received at least one marketing send."
          />
          <CoverageMetric
            label="With marketing consent"
            value={coverage.data?.consented}
            measured={coverage.data?.measured ?? false}
            noActionReason="Consent coverage of the people contacted — an H_MKT input."
          />
          <CoverageMetric
            label="Consent missing"
            value={coverage.data?.missing}
            measured={coverage.data?.measured ?? false}
            tone={coverage.data && coverage.data.missing > 0 ? 'warn' : 'neutral'}
            noActionReason="Contacted without a recorded marketing consent."
          />
        </div>
      )}

      <Card
        title="Find a person"
        subtitle="Search by name, phone, email or record code — the same directory Contacts uses."
        className="mb-4"
      >
        <input
          className="input max-w-md"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people…"
        />
        {q.length >= 2 && (
          <div className="mt-2 space-y-1">
            {isFetching ? (
              <Loading label="Searching" />
            ) : !search?.items.length ? (
              <p className="text-2xs italic text-ink-500">Nobody matches.</p>
            ) : (
              search.items.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full items-center justify-between gap-2 rounded border border-ink-800 px-2.5 py-1.5 text-left hover:border-ink-600"
                  onClick={() => {
                    setPersonId(p.id);
                    setPersonLabel(p.fullName);
                  }}
                >
                  <div>
                    <p className="text-xs text-ink-100">{p.fullName}</p>
                    <p className="text-2xs text-ink-500">
                      {[p.primaryEmail, p.primaryPhone].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <RecordCode code={p.recordCode} />
                </button>
              ))
            )}
          </div>
        )}
      </Card>

      {personId && (
        <PreferencePanel personId={personId} personLabel={personLabel} canEdit={can('marketing_settings:E')} />
      )}

      <p className="mt-6 max-w-2xl text-2xs leading-relaxed text-ink-500">
        Consent recorded here is bound to a single purpose — <span className="mono">marketing</span> — as the DPDP
        (Digital Personal Data Protection) Act requires: it says this person agreed to be contacted for marketing,
        nothing wider, and it never authorises use for a different purpose recorded elsewhere in the platform.
      </p>
    </div>
  );
}

function CoverageMetric({
  label,
  value,
  measured,
  tone = 'neutral',
  noActionReason,
}: {
  label: string;
  value: number | undefined;
  measured: boolean;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
  noActionReason: string;
}) {
  return (
    <Metric
      label={label}
      value={measured ? (value ?? 0).toLocaleString('en-IN') : <span className="text-sm italic text-ink-500">Not yet measured</span>}
      tone={tone}
      noActionReason={noActionReason}
    />
  );
}

function PreferencePanel({ personId, personLabel, canEdit }: { personId: string; personLabel: string; canEdit: boolean }) {
  const { data, isLoading, error } = usePreferences(personId);
  const [banner, setBanner] = useState<string | null>(null);
  const [consentChannel, setConsentChannel] = useState<(typeof CONSENT_CHANNELS)[number]['value']>('portal');
  const [evidence, setEvidence] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [dncReason, setDncReason] = useState('');

  const recordConsent = useRecordConsent();
  const withdraw = useWithdrawConsent();
  const setChannel = useSetChannelPreference();
  const setDnc = useSetDoNotContact();

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? new Error('Could not load preferences')} />;

  const channelMap = new Map(data.channels.map((c) => [c.channelKey, c]));

  return (
    <Card title={personLabel} subtitle="Marketing standing for this person.">
      {banner && (
        <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
          {banner}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="section-title">Marketing consent</p>
          {data.consent ? (
            <dl>
              <Field label="Status">
                <StatusChip status={data.consent.status} tone={data.consent.status === 'granted' ? 'good' : 'warn'} />
              </Field>
              <Field label="Recorded">{dateTime(data.consent.recordedAt)}</Field>
              <Field label="Channel">{titleCase(data.consent.channel)}</Field>
            </dl>
          ) : (
            <EmptyState message="No marketing consent recorded yet." hint="A send cannot reach this person until consent is recorded." />
          )}

          {canEdit && (
            <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950 p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="label">How it was given</span>
                  <select className="input" value={consentChannel} onChange={(e) => setConsentChannel(e.target.value as typeof consentChannel)}>
                    {CONSENT_CHANNELS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Evidence (optional)</span>
                  <input className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Form ref, recording ref…" />
                </label>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-primary"
                  disabled={recordConsent.isPending}
                  onClick={() =>
                    recordConsent.mutate(
                      { personId, channel: consentChannel, evidence: evidence || undefined },
                      { onError: (e) => setBanner(messageOf(e)) },
                    )
                  }
                >
                  {recordConsent.isPending ? 'Recording…' : 'Record consent'}
                </button>
                {data.consent && (
                  <button
                    className="btn-ghost text-band-critical"
                    disabled={withdraw.isPending}
                    onClick={() => {
                      const reason = withdrawReason || prompt('Reason for withdrawing consent (optional)?') || undefined;
                      withdraw.mutate({ personId, reason }, { onError: (e) => setBanner(messageOf(e)) });
                    }}
                  >
                    Withdraw consent
                  </button>
                )}
              </div>
              <input
                className="input"
                placeholder="Reason to use if you click Withdraw (optional)"
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <p className="section-title">Do not contact</p>
          {data.doNotContact ? (
            <StatusChip status="Do not contact" tone="bad" />
          ) : (
            <StatusChip status="May be contacted" tone="good" />
          )}
          {canEdit && (
            <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950 p-3">
              <input
                className="input"
                placeholder="Reason (required to set or to lift)"
                value={dncReason}
                onChange={(e) => setDncReason(e.target.value)}
              />
              <div className="flex gap-2">
                {!data.doNotContact ? (
                  <button
                    className="btn-ghost text-band-critical"
                    disabled={setDnc.isPending || !dncReason}
                    onClick={() =>
                      setDnc.mutate(
                        { personId, doNotContact: true, reason: dncReason },
                        { onSuccess: () => setDncReason(''), onError: (e) => setBanner(messageOf(e)) },
                      )
                    }
                  >
                    Mark do-not-contact
                  </button>
                ) : (
                  <button
                    className="btn-ghost"
                    disabled={setDnc.isPending || !dncReason}
                    onClick={() =>
                      setDnc.mutate(
                        { personId, doNotContact: false, reason: dncReason },
                        { onSuccess: () => setDncReason(''), onError: (e) => setBanner(messageOf(e)) },
                      )
                    }
                  >
                    Lift do-not-contact
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5">
        <p className="section-title mb-2">Channel opt-ins</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CHANNEL_KEYS.map((ck) => {
            const pref = channelMap.get(ck);
            const optedIn = pref?.optedIn ?? false;
            return (
              <div key={ck} className="flex items-center justify-between gap-2 rounded-md border border-ink-800 bg-ink-900 px-3 py-2">
                <div>
                  <p className="text-xs text-ink-100">{CHANNEL_KEY_LABELS[ck]}</p>
                  {pref && <p className="text-2xs text-ink-500">since {dateTime(pref.changedAt)} · {titleCase(pref.source)}</p>}
                </div>
                {canEdit ? (
                  <button
                    className={`chip ${optedIn ? 'border-band-strong/40 bg-band-strong/10 text-band-strong' : 'border-ink-700 text-ink-400'}`}
                    onClick={() =>
                      setChannel.mutate(
                        { personId, channelKey: ck as ChannelKey, optedIn: !optedIn, source: 'agent' as PreferenceChangeSource },
                        { onError: (e) => setBanner(messageOf(e)) },
                      )
                    }
                  >
                    {optedIn ? 'Opted in' : 'Opted out'}
                  </button>
                ) : (
                  <StatusChip status={optedIn ? 'Opted in' : 'Opted out'} tone={optedIn ? 'good' : 'neutral'} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
