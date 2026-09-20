/**
 * Rounds — the container an allotment, a bonus, a rights offer, a buy-back
 * or a capital reduction is struck under (equity-portal plan §6 phase 4).
 *
 * The new-round dialog's fields change by kind, and the statutory
 * prerequisite each kind needs before it may open is named in plain words
 * beside the field that satisfies it — the same discipline the register
 * already keeps for a certificate's two signatories.
 */
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FUNDING_ROUND_KIND_LABELS, type FundingRoundKind, type FundingRoundView, type ShareTransactionView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextInput, messageOf } from '../../components/forms.js';

const KIND_OPTIONS = Object.entries(FUNDING_ROUND_KIND_LABELS).map(([value, label]) => ({ value: value as FundingRoundKind, label }));

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  open: 'accent',
  closed: 'good',
  cancelled: 'bad',
};

function useValuations() {
  return useQuery({
    queryKey: ['equity-valuations', 'picker'],
    queryFn: () => api.get<{ items: Array<{ id: string; recordCode: string; basis: string; asOf: string }> }>('/equity/valuations'),
  });
}

/** What the chosen kind needs before it may open — the same words `openRound` refuses with. */
function Prerequisites({ kind }: { kind: FundingRoundKind | '' }) {
  const notes: Record<string, string> = {
    preferential: "Needs a registered valuer's report dated before opening (Rule 13).",
    private_placement: "Needs a registered valuer's report dated before opening (Rule 13), a PAS-4 offer letter serial, a separate bank account, and the offeree count — capped at 200 persons a year across every private-placement round (s.42).",
    bonus: 'Needs a named source — free reserves, securities premium, or the capital redemption reserve (s.63). A bonus from free reserves refuses to open unless they are measured and positive.',
    sweat_equity: 'Needs a valuation report reference (s.54).',
    capital_reduction: 'Needs the tribunal order this reduction is recorded against (s.66) — the act itself is not workflowed, only recorded.',
    buyback: 'Needs free reserves to be measurable before it may open; each buy-back proposed under it is checked against the 10%/25% and debt-equity (2:1) tests when it is proposed.',
    rights_issue: 'Records whether an entitlement may be renounced to a named third party (s.62(1)(a)).',
  };
  if (!kind || !notes[kind]) return null;
  return <p className="rounded-md bg-gold-soft px-3 py-2 text-2xs text-accent-soft">{notes[kind]}</p>;
}

function NewRound({ open, onClose }: { open: boolean; onClose: () => void }) {
  const valuations = useValuations();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FundingRoundKind | ''>('');
  const [preMoneyValuation, setPreMoney] = useState('');
  const [valuationId, setValuationId] = useState('');
  const [boardResolutionRef, setBoardRef] = useState('');
  const [shareholderResolutionRef, setShareholderRef] = useState('');
  const [offerLetterSerial, setOfferLetter] = useState('');
  const [separateBankAccountRef, setBankRef] = useState('');
  const [offereeCount, setOffereeCount] = useState('');
  const [renunciationAllowed, setRenunciation] = useState<'yes' | 'no' | ''>('');
  const [sourceOfBonus, setSourceOfBonus] = useState('');
  const [valuationReportRef, setValuationReportRef] = useState('');
  const [tribunalOrderRef, setTribunalRef] = useState('');

  const needsValuation = kind === 'preferential' || kind === 'private_placement';
  const isPrivatePlacement = kind === 'private_placement';
  const isBonus = kind === 'bonus';
  const isSweatEquity = kind === 'sweat_equity';
  const isCapitalReduction = kind === 'capital_reduction';
  const isRights = kind === 'rights_issue';

  return (
    <CreateModal
      open={open}
      title="New round"
      submitLabel="Create it"
      onClose={onClose}
      invalidate={[['equity-rounds']]}
      onSubmit={() =>
        api.post('/equity/rounds', {
          name,
          kind,
          preMoneyValuation: preMoneyValuation ? Number(preMoneyValuation) : null,
          valuationId: needsValuation && valuationId ? valuationId : null,
          boardResolutionRef: boardResolutionRef || null,
          shareholderResolutionRef: shareholderResolutionRef || null,
          offerLetterSerial: isPrivatePlacement ? offerLetterSerial || null : null,
          separateBankAccountRef: isPrivatePlacement ? separateBankAccountRef || null : null,
          offereeCount: isPrivatePlacement && offereeCount ? Number(offereeCount) : null,
          renunciationAllowed: isRights && renunciationAllowed ? renunciationAllowed === 'yes' : null,
          sourceOfBonus: isBonus && sourceOfBonus ? sourceOfBonus : null,
          valuationReportRef: isSweatEquity ? valuationReportRef || null : null,
          tribunalOrderRef: isCapitalReduction ? tribunalOrderRef || null : null,
        })
      }
    >
      <Row>
        <TextInput label="Name" required value={name} onChange={setName} />
        <SelectInput label="Kind" required value={kind} onChange={(v) => setKind(v)} placeholder="Choose a kind" options={KIND_OPTIONS} />
      </Row>
      <Prerequisites kind={kind} />
      <Row>
        <TextInput label="Pre-money valuation" type="number" value={preMoneyValuation} onChange={setPreMoney} />
        <TextInput label="Board resolution ref." value={boardResolutionRef} onChange={setBoardRef} />
      </Row>

      {needsValuation && (
        <SelectInput
          label="Valuation on record"
          hint="registered valuer, dated before opening"
          value={valuationId}
          onChange={setValuationId}
          placeholder="Choose a recorded valuation"
          options={(valuations.data?.items ?? []).map((v) => ({ value: v.id, label: `${v.recordCode} · ${v.basis} · ${date(v.asOf)}` }))}
        />
      )}

      {isPrivatePlacement && (
        <>
          <Row>
            <TextInput label="Offer letter serial (PAS-4)" value={offerLetterSerial} onChange={setOfferLetter} />
            <TextInput label="Separate bank account ref." value={separateBankAccountRef} onChange={setBankRef} />
          </Row>
          <Row>
            <TextInput label="Offeree count" type="number" hint="counted against the 200-person s.42 ceiling for the year" value={offereeCount} onChange={setOffereeCount} />
            <TextInput label="Shareholder resolution ref." value={shareholderResolutionRef} onChange={setShareholderRef} />
          </Row>
        </>
      )}

      {isRights && (
        <SelectInput
          label="Renunciation allowed"
          value={renunciationAllowed}
          onChange={(v) => setRenunciation(v as 'yes' | 'no')}
          placeholder="Choose"
          options={[{ value: 'yes', label: 'Yes — entitlements may be renounced to a named holder' }, { value: 'no', label: 'No' }]}
        />
      )}

      {isBonus && (
        <SelectInput
          label="Source of bonus"
          value={sourceOfBonus}
          onChange={setSourceOfBonus}
          placeholder="Choose a source"
          options={[
            { value: 'free_reserves', label: 'Free reserves' },
            { value: 'securities_premium', label: 'Securities premium' },
            { value: 'capital_redemption_reserve', label: 'Capital redemption reserve' },
          ]}
        />
      )}

      {isSweatEquity && <TextInput label="Valuation report ref." value={valuationReportRef} onChange={setValuationReportRef} />}
      {isCapitalReduction && <TextInput label="Tribunal order ref." value={tribunalOrderRef} onChange={setTribunalRef} />}
      {kind === 'buyback' && (
        <TextInput label="Shareholder resolution ref." hint="needed above 10% of paid-up capital + free reserves" value={shareholderResolutionRef} onChange={setShareholderRef} />
      )}
    </CreateModal>
  );
}

export function Rounds() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['equity-rounds'],
    queryFn: () => api.get<{ items: FundingRoundView[] }>('/equity/rounds'),
  });

  const { data: detail } = useQuery({
    queryKey: ['equity-round', openId],
    queryFn: () => api.get<{ round: FundingRoundView; transactions: ShareTransactionView[]; raised: number; postMoney: number | null }>(`/equity/rounds/${openId}`),
    enabled: Boolean(openId),
  });

  const act = useMutation({
    mutationFn: (input: { id: string; path: 'open' | 'close' | 'cancel' }) => api.post(`/equity/rounds/${input.id}/${input.path}`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['equity-rounds'] });
      qc.invalidateQueries({ queryKey: ['equity-round'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  return (
    <div>
      <NewRound open={creating} onClose={() => setCreating(false)} />

      <PageHeader
        title="Rounds"
        subtitle="Preferential allotments, private placements, bonus and rights issues, buy-backs — each with the statutory prerequisite its kind needs before it opens."
        actions={can('rounds:C') && <NewButton label="New round" onClick={() => setCreating(true)} />}
      />

      {error && (
        <p className="mb-4 rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}

      {isLoading ? (
        <Loading />
      ) : (data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState message="No rounds yet." hint="Create one to bring a preferential allotment, a bonus, or a buy-back onto the register." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th className="text-right">Raised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((r) => (
                  <Fragment key={r.id}>
                    <tr className="cursor-pointer" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                      <td className="mono text-2xs">
                        {r.recordCode}
                        <div className="text-xs text-ink-100">{r.name}</div>
                      </td>
                      <td className="text-ink-300">{FUNDING_ROUND_KIND_LABELS[r.kind as FundingRoundKind] ?? r.kind}</td>
                      <td>
                        <StatusChip status={r.status} tone={STATUS_TONE[r.status] ?? 'neutral'} />
                      </td>
                      <td className="text-2xs text-ink-400">{r.openedOn ? date(r.openedOn) : '—'}</td>
                      <td className="text-2xs text-ink-400">{r.closedOn ? date(r.closedOn) : '—'}</td>
                      <td className="text-right tabular-nums">{r.raised ?? '—'}</td>
                      <td>
                        <div className="flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          {r.status === 'draft' && can('rounds:approve') && (
                            <button className="btn-ghost" onClick={() => act.mutate({ id: r.id, path: 'open' })} disabled={act.isPending}>
                              Open
                            </button>
                          )}
                          {r.status === 'open' && can('rounds:approve') && (
                            <button className="btn-primary btn-sm" onClick={() => act.mutate({ id: r.id, path: 'close' })} disabled={act.isPending}>
                              Close
                            </button>
                          )}
                          {(r.status === 'draft' || r.status === 'open') && can('rounds:approve') && (
                            <button className="btn-ghost" onClick={() => act.mutate({ id: r.id, path: 'cancel' })} disabled={act.isPending}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {openId === r.id && detail && (
                      <tr>
                        <td colSpan={7} className="bg-ink-950/60 p-4">
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <div className="label">Pre-money</div>
                              <div className="num text-sm">{detail.round.preMoneyValuation ?? '—'}</div>
                            </div>
                            <div>
                              <div className="label">Post-money</div>
                              <div className="num text-sm">{detail.postMoney ?? '—'}</div>
                            </div>
                            <div>
                              <div className="label">Raised</div>
                              <div className="num text-sm">{detail.raised}</div>
                            </div>
                          </div>
                          {detail.transactions.length === 0 ? (
                            <p className="mt-3 text-2xs text-ink-500">No transactions under this round yet.</p>
                          ) : (
                            <table className="table mt-3">
                              <thead>
                                <tr>
                                  <th>Type</th>
                                  <th className="text-right">Count</th>
                                  <th>Status</th>
                                  <th>Effective on</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.transactions.map((t) => (
                                  <tr key={t.id}>
                                    <td className="mono text-2xs">{t.recordCode}</td>
                                    <td className="text-right tabular-nums">{t.count.toLocaleString('en-IN')}</td>
                                    <td>
                                      <StatusChip status={t.status} tone="neutral" />
                                    </td>
                                    <td className="text-2xs text-ink-400">{t.effectiveOn ? date(t.effectiveOn) : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
