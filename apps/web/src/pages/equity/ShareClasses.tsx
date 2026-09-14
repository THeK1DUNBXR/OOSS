/**
 * Share classes — the instruments the company has issued.
 *
 * `rights` is a free-form JSON object on the API side; the keys used here
 * (`liquidationPreferenceMultiple`, `participating`, `antiDilution`,
 * `proRata`, `boardSeat`, `informationRights`, `dividendRate`) are this
 * screen's own vocabulary for it, written once here and read back the same
 * way — there is no shared enum for them in `@kaizen/shared`.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SHARE_INSTRUMENTS, SHARE_INSTRUMENT_LABELS, type ShareClassKind, type ShareClassView, type ShareInstrument } from '@kaizen/shared';
import { api, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Field, Loading, PageHeader } from '../../components/ui.js';
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

type AntiDilution = 'none' | 'broad' | 'full_ratchet';

const ANTI_DILUTION_LABELS: Record<AntiDilution, string> = {
  none: 'None',
  broad: 'Broad-based weighted average',
  full_ratchet: 'Full ratchet',
};

function NewShareClass({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ShareClassKind>('equity');
  const [instrument, setInstrument] = useState<ShareInstrument>('equity');
  const [faceValue, setFaceValue] = useState('10');
  const [votesPerShare, setVotesPerShare] = useState('1');
  const [authorisedCount, setAuthorisedCount] = useState('');
  const [liquidationPreferenceMultiple, setLiqPref] = useState('');
  const [participating, setParticipating] = useState(false);
  const [antiDilution, setAntiDilution] = useState<AntiDilution>('none');
  const [proRata, setProRata] = useState(false);
  const [boardSeat, setBoardSeat] = useState(false);
  const [informationRights, setInformationRights] = useState(false);
  const [dividendRate, setDividendRate] = useState('');

  return (
    <CreateModal
      open={open}
      title="New share class"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['equity-share-classes']]}
      onSubmit={() =>
        api.post('/equity/share-classes', {
          name,
          kind,
          instrument,
          faceValue: Number(faceValue || 0),
          votesPerShare: votesPerShare ? Number(votesPerShare) : undefined,
          authorisedCount: authorisedCount ? Number(authorisedCount) : null,
          rights: {
            liquidationPreferenceMultiple: liquidationPreferenceMultiple ? Number(liquidationPreferenceMultiple) : null,
            participating,
            antiDilution,
            proRata,
            boardSeat,
            informationRights,
            dividendRate: dividendRate ? Number(dividendRate) : null,
          },
        })
      }
    >
      <TextInput label="Name" required autoFocus value={name} onChange={setName} placeholder="Series A CCPS" />
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as ShareClassKind)}
          options={[
            { value: 'equity', label: 'Equity' },
            { value: 'preference', label: 'Preference' },
            { value: 'debenture', label: 'Debenture' },
          ]}
        />
        <SelectInput
          label="Instrument"
          required
          value={instrument}
          onChange={(v) => setInstrument(v as ShareInstrument)}
          options={SHARE_INSTRUMENTS.map((i) => ({ value: i, label: SHARE_INSTRUMENT_LABELS[i] }))}
        />
      </Row>
      <Row>
        <MoneyInput label="Face value" required value={faceValue} onChange={setFaceValue} />
        <TextInput label="Votes per share" type="number" value={votesPerShare} onChange={setVotesPerShare} />
      </Row>
      <TextInput label="Authorised count" type="number" value={authorisedCount} onChange={setAuthorisedCount} />

      <fieldset className="rounded-lg border border-ink-800 p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Rights</legend>
        <div className="flex flex-col gap-3">
          <Row>
            <TextInput
              label="Liquidation preference"
              type="number"
              hint="multiple, e.g. 1"
              value={liquidationPreferenceMultiple}
              onChange={setLiqPref}
            />
            <TextInput label="Dividend rate" type="number" hint="% a year" value={dividendRate} onChange={setDividendRate} />
          </Row>
          <SelectInput
            label="Anti-dilution"
            value={antiDilution}
            onChange={(v) => setAntiDilution(v as AntiDilution)}
            options={(['none', 'broad', 'full_ratchet'] as AntiDilution[]).map((v) => ({ value: v, label: ANTI_DILUTION_LABELS[v] }))}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['participating', 'Participating', participating, setParticipating],
                ['proRata', 'Pro-rata right', proRata, setProRata],
                ['boardSeat', 'Board seat', boardSeat, setBoardSeat],
                ['informationRights', 'Information rights', informationRights, setInformationRights],
              ] as Array<[string, string, boolean, (v: boolean) => void]>
            ).map(([key, label, value, setValue]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-ink-200">
                <input type="checkbox" checked={value} onChange={(e) => setValue(e.target.checked)} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </fieldset>
    </CreateModal>
  );
}

export function ShareClasses() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-share-classes'],
    queryFn: () => api.get<{ items: ShareClassView[] }>('/equity/share-classes'),
  });

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];

  return (
    <div>
      <NewShareClass open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        title="Share classes"
        subtitle="The instruments the company has issued."
        actions={can('share_classes:C') && <NewButton label="New class" onClick={() => setCreating(true)} />}
      />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="No share class is set up yet." hint="Add one before the first allotment can be proposed." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((c) => {
            const rights = c.rights as Record<string, unknown>;
            return (
              <Card key={c.id} title={c.name} subtitle={SHARE_INSTRUMENT_LABELS[c.instrument]}>
                <dl>
                  <Field label="Face value">{money(c.faceValue)}</Field>
                  <Field label="Votes per share">{c.votesPerShare}</Field>
                  <Field label="Authorised count">{c.authorisedCount?.toLocaleString('en-IN') ?? 'Not capped'}</Field>
                  <Field label="Status">{c.status === 'active' ? 'Active' : 'Closed'}</Field>
                  {typeof rights?.liquidationPreferenceMultiple === 'number' && (
                    <Field label="Liquidation preference">{rights.liquidationPreferenceMultiple}×</Field>
                  )}
                  {typeof rights?.dividendRate === 'number' && <Field label="Dividend rate">{rights.dividendRate}%</Field>}
                  {Boolean(rights?.antiDilution) && rights.antiDilution !== 'none' && (
                    <Field label="Anti-dilution">{String(rights.antiDilution).replace(/_/g, ' ')}</Field>
                  )}
                  {Boolean(rights?.participating || rights?.proRata || rights?.boardSeat || rights?.informationRights) && (
                    <Field label="Also carries">
                      {[
                        rights.participating && 'participating',
                        rights.proRata && 'pro-rata',
                        rights.boardSeat && 'board seat',
                        rights.informationRights && 'information rights',
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </Field>
                  )}
                </dl>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
