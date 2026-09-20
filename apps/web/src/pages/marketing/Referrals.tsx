/**
 * Referral programmes, the referrals issued under them, and the leaderboard.
 * A referral moves issued → used → qualified → rewarded (or void at any
 * point) — the actions shown are exactly what REFERRAL_TRANSITIONS allows
 * from wherever a row currently sits.
 */

import { useState } from 'react';
import {
  REFERRAL_PROGRAM_KINDS,
  REFERRAL_PROGRAM_KIND_LABELS,
  REFERRAL_STATUSES,
  REFERRAL_STATUS_LABELS,
  REFERRAL_TRANSITIONS,
  REWARD_KINDS,
  REWARD_KIND_LABELS,
  type ReferralProgramKind,
  type ReferralProgramView,
  type ReferralStatus,
  type RewardKind,
} from '@kaizen/shared';
import { titleCase } from '../../lib/api.js';
import {
  useReferralPrograms,
  useCreateReferralProgram,
  useActivateReferralProgram,
  useDeactivateReferralProgram,
  useReferrals,
  useIssueReferral,
  useRedeemReferral,
  useQualifyReferral,
  useRewardReferral,
  useVoidReferral,
  useReferralLeaderboard,
} from '../../lib/marketingApi.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip, Tabs } from '../../components/ui.js';
import { CreateModal, Row, SelectInput, TextInput, messageOf, NewButton } from '../../components/forms.js';
import { useSession } from '../../lib/session.js';

type RefTab = 'programmes' | 'referrals' | 'leaderboard';

export function Referrals() {
  const { can } = useSession();
  const [tab, setTab] = useState<RefTab>('programmes');
  const [creatingProgramme, setCreatingProgramme] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [programFilter, setProgramFilter] = useState('');

  const programs = useReferralPrograms();

  return (
    <div>
      <PageHeader
        title="Referrals"
        subtitle="Programmes, the codes issued under them, and who's earned a reward."
        actions={
          can('marketing_referrals:C') && (
            <>
              {tab === 'programmes' && <NewButton label="New programme" onClick={() => setCreatingProgramme(true)} />}
              {tab === 'referrals' && (
                <>
                  <button className="btn" onClick={() => setRedeeming(true)}>Redeem a code</button>
                  <button className="btn-primary" onClick={() => setIssuing(true)}>Issue a code</button>
                </>
              )}
            </>
          )
        }
      />

      <Tabs
        tabs={[
          { key: 'programmes', label: 'Programmes', count: programs.data?.total },
          { key: 'referrals', label: 'Referrals' },
          { key: 'leaderboard', label: 'Leaderboard' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'programmes' && <ProgrammesTab />}
      {tab === 'referrals' && <ReferralsTab programId={programFilter} onProgramChange={setProgramFilter} />}
      {tab === 'leaderboard' && <LeaderboardTab programId={programFilter} onProgramChange={setProgramFilter} />}

      <CreateProgrammeModal open={creatingProgramme} onClose={() => setCreatingProgramme(false)} />
      <IssueModal open={issuing} onClose={() => setIssuing(false)} />
      <RedeemModal open={redeeming} onClose={() => setRedeeming(false)} />
    </div>
  );
}

function ProgrammesTab() {
  const { can } = useSession();
  const programs = useReferralPrograms();
  const activate = useActivateReferralProgram();
  const deactivate = useDeactivateReferralProgram();
  const [error, setError] = useState<string | null>(null);

  if (programs.isLoading) return <Loading />;
  if (programs.error) return <ErrorBox error={programs.error} />;
  const items = programs.data?.items ?? [];

  return (
    <div>
      {error && <p className="mb-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}
      {items.length === 0 ? (
        <Card><EmptyState message="No referral programmes yet." /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((p: ReferralProgramView) => (
            <Card
              key={p.id}
              title={p.name}
              subtitle={<span className="mono">{p.recordCode}</span>}
              actions={<StatusChip status={p.active ? 'active' : 'inactive'} tone={p.active ? 'good' : 'neutral'} />}
            >
              <p className="text-2xs text-ink-400">{REFERRAL_PROGRAM_KIND_LABELS[p.kind]}</p>
              <p className="mt-1 text-xs text-ink-200">
                Reward: {REWARD_KIND_LABELS[p.rewardKind]}
                {p.rewardAmount ? ` — ${p.rewardAmount}` : ''}
              </p>
              {p.terms && <p className="mt-2 text-2xs text-ink-500">{p.terms}</p>}
              {can('marketing_referrals:E') && (
                <div className="mt-3 border-t border-ink-800 pt-3">
                  {p.active ? (
                    <button className="btn-quiet btn-sm" onClick={() => deactivate.mutate(p.id, { onError: (e) => setError(messageOf(e)) })}>Deactivate</button>
                  ) : (
                    <button className="btn-quiet btn-sm" onClick={() => activate.mutate(p.id, { onError: (e) => setError(messageOf(e)) })}>Activate</button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateProgrammeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateReferralProgram();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ReferralProgramKind>('student');
  const [rewardKind, setRewardKind] = useState<RewardKind>('cash');
  const [rewardAmount, setRewardAmount] = useState('');
  const [terms, setTerms] = useState('');

  return (
    <CreateModal
      open={open}
      title="New referral programme"
      onClose={onClose}
      invalidate={[['mkt', 'referral-programs']]}
      onSubmit={() => create.mutateAsync({ name, kind, rewardKind, rewardAmount: rewardAmount ? Number(rewardAmount) : undefined, terms: terms || undefined })}
    >
      <TextInput label="Name" required value={name} onChange={setName} placeholder="Student referral — batch 12" />
      <Row>
        <SelectInput label="Kind" value={kind} onChange={(v) => setKind(v as ReferralProgramKind)} options={REFERRAL_PROGRAM_KINDS.map((k) => ({ value: k, label: REFERRAL_PROGRAM_KIND_LABELS[k] }))} />
        <SelectInput label="Reward" value={rewardKind} onChange={(v) => setRewardKind(v as RewardKind)} options={REWARD_KINDS.map((k) => ({ value: k, label: REWARD_KIND_LABELS[k] }))} />
      </Row>
      {rewardKind !== 'none' && <TextInput label="Reward amount" type="number" value={rewardAmount} onChange={setRewardAmount} />}
      <TextInput label="Terms" value={terms} onChange={setTerms} placeholder="One reward per successful enrolment" />
    </CreateModal>
  );
}

function ReferralsTab({ programId, onProgramChange }: { programId: string; onProgramChange: (v: string) => void }) {
  const { can } = useSession();
  const programs = useReferralPrograms();
  const [status, setStatus] = useState<ReferralStatus | ''>('');
  const referrals = useReferrals({ programId: programId || undefined, status: status || undefined });
  const qualify = useQualifyReferral();
  const [rewarding, setRewarding] = useState<string | null>(null);
  const voidRef = useVoidReferral();
  const [error, setError] = useState<string | null>(null);

  if (referrals.isLoading) return <Loading />;
  if (referrals.error) return <ErrorBox error={referrals.error} />;
  const items = referrals.data?.items ?? [];

  return (
    <div>
      <Row>
        <SelectInput label="Programme" value={programId} onChange={onProgramChange} placeholder="All programmes" options={(programs.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <SelectInput label="Status" value={status} onChange={(v) => setStatus(v as ReferralStatus)} placeholder="All statuses" options={REFERRAL_STATUSES.map((s) => ({ value: s, label: REFERRAL_STATUS_LABELS[s] }))} />
      </Row>

      {error && <p className="my-3 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>}

      {items.length === 0 ? (
        <Card className="mt-4"><EmptyState message="No referrals match." /></Card>
      ) : (
        <Card className="mt-4" bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Code</th><th>Programme</th><th>Referrer</th><th>Referred</th><th>Lead</th><th>Status</th><th /></tr></thead>
            <tbody>
              {items.map((r) => {
                const next = REFERRAL_TRANSITIONS[r.status] ?? [];
                return (
                  <tr key={r.id}>
                    <td className="mono text-xs text-ink-100">{r.code}</td>
                    <td className="text-xs text-ink-300">{r.programName}</td>
                    <td className="text-xs text-ink-200">{r.referrerName ?? r.referrerOrganizationName ?? '—'}</td>
                    <td className="text-xs text-ink-200">{r.referredName ?? '—'}</td>
                    <td className="mono text-2xs text-ink-400">{r.leadRecordCode ?? '—'}</td>
                    <td><StatusChip status={r.status} tone={r.status === 'rewarded' ? 'good' : r.status === 'void' ? 'bad' : 'neutral'} /></td>
                    <td>
                      {can('marketing_referrals:E') && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {next.includes('qualified') && (
                            <button className="btn-quiet btn-sm" onClick={() => qualify.mutate(r.id, { onError: (e) => setError(messageOf(e)) })}>Qualify</button>
                          )}
                          {next.includes('rewarded') && (
                            <button className="btn-quiet btn-sm" onClick={() => setRewarding(r.id)}>Reward</button>
                          )}
                          {next.includes('void') && (
                            <button
                              className="btn-quiet btn-sm"
                              onClick={() => {
                                const reason = prompt('Reason for voiding this referral?');
                                if (reason) voidRef.mutate({ id: r.id, reason }, { onError: (e) => setError(messageOf(e)) });
                              }}
                            >
                              Void
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {rewarding && <RewardModal id={rewarding} onClose={() => setRewarding(null)} />}
    </div>
  );
}

function RewardModal({ id, onClose }: { id: string; onClose: () => void }) {
  const reward = useRewardReferral();
  const [rewardTransactionRef, setRef] = useState('');

  return (
    <CreateModal
      open
      title="Record the reward"
      onClose={onClose}
      invalidate={[['mkt', 'referrals']]}
      onSubmit={() => reward.mutateAsync({ id, rewardTransactionRef: rewardTransactionRef || undefined })}
    >
      <TextInput label="Finance transaction reference" value={rewardTransactionRef} onChange={setRef} hint="marketing never posts money itself — this points at the ledger entry" />
    </CreateModal>
  );
}

function IssueModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const programs = useReferralPrograms();
  const issue = useIssueReferral();
  const [programId, setProgramId] = useState('');
  const [who, setWho] = useState<'person' | 'organization'>('person');
  const [referrerPersonId, setReferrerPersonId] = useState('');
  const [referrerOrganizationId, setReferrerOrganizationId] = useState('');

  return (
    <CreateModal
      open={open}
      title="Issue a referral code"
      onClose={onClose}
      invalidate={[['mkt', 'referrals']]}
      onSubmit={() =>
        issue.mutateAsync({
          programId,
          referrerPersonId: who === 'person' ? referrerPersonId : undefined,
          referrerOrganizationId: who === 'organization' ? referrerOrganizationId : undefined,
        })
      }
    >
      <SelectInput label="Programme" required value={programId} onChange={setProgramId} options={(programs.data?.items ?? []).filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))} />
      <div className="flex gap-2">
        {(['person', 'organization'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setWho(v)}
            className={`chip transition-colors ${who === v ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500'}`}
          >
            {titleCase(v)}
          </button>
        ))}
      </div>
      {who === 'person' ? (
        <TextInput label="Referrer person ID" required value={referrerPersonId} onChange={setReferrerPersonId} />
      ) : (
        <TextInput label="Referrer organization ID" required value={referrerOrganizationId} onChange={setReferrerOrganizationId} />
      )}
    </CreateModal>
  );
}

function RedeemModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const redeem = useRedeemReferral();
  const [code, setCode] = useState('');
  const [who, setWho] = useState<'existing' | 'new'>('new');
  const [referredPersonId, setReferredPersonId] = useState('');
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');

  return (
    <CreateModal
      open={open}
      title="Redeem a referral code"
      onClose={onClose}
      invalidate={[['mkt', 'referrals']]}
      onSubmit={() =>
        redeem.mutateAsync(
          who === 'existing'
            ? { code, referredPersonId }
            : { code, person: { fullName, primaryPhone: primaryPhone || undefined, primaryEmail: primaryEmail || undefined } },
        )
      }
    >
      <TextInput label="Code" required value={code} onChange={setCode} />
      <div className="flex gap-2">
        {(['new', 'existing'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setWho(v)}
            className={`chip transition-colors ${who === v ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500'}`}
          >
            {v === 'existing' ? 'Somebody already on file' : 'Somebody new'}
          </button>
        ))}
      </div>
      {who === 'existing' ? (
        <TextInput label="Referred person ID" required value={referredPersonId} onChange={setReferredPersonId} />
      ) : (
        <>
          <TextInput label="Name" required value={fullName} onChange={setFullName} />
          <Row>
            <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} />
            <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
          </Row>
        </>
      )}
      <p className="text-2xs text-ink-500">Redeeming creates a lead attributed to this referral.</p>
    </CreateModal>
  );
}

function LeaderboardTab({ programId, onProgramChange }: { programId: string; onProgramChange: (v: string) => void }) {
  const programs = useReferralPrograms();
  const leaderboard = useReferralLeaderboard(programId || undefined);

  return (
    <div>
      <SelectInput label="Programme" value={programId} onChange={onProgramChange} placeholder="Choose a programme" options={(programs.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} />

      {!programId ? (
        <Card className="mt-4"><EmptyState message="Choose a programme to see its leaderboard." /></Card>
      ) : leaderboard.isLoading ? (
        <Loading />
      ) : leaderboard.error ? (
        <ErrorBox error={leaderboard.error} />
      ) : !leaderboard.data?.length ? (
        <Card className="mt-4"><EmptyState message="No referrers yet under this programme." /></Card>
      ) : (
        <Card className="mt-4" bodyClassName="p-0 overflow-x-auto">
          <table className="table">
            <thead><tr><th>Referrer</th><th className="text-right">Issued</th><th className="text-right">Used</th><th className="text-right">Qualified</th><th className="text-right">Rewarded</th></tr></thead>
            <tbody>
              {leaderboard.data.map((row, i) => (
                <tr key={i}>
                  <td className="text-xs text-ink-100">{row.referrerLabel}</td>
                  <td className="text-right tabular-nums text-xs">{row.issued}</td>
                  <td className="text-right tabular-nums text-xs">{row.used}</td>
                  <td className="text-right tabular-nums text-xs">{row.qualified}</td>
                  <td className="text-right tabular-nums text-xs">{row.rewarded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
