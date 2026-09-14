/**
 * Valuations — the record of what a share was worth, as of when, and on
 * what basis. The cap table reads its "last valuation" line from this list.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { VALUATION_BASES, VALUATION_BASIS_LABELS, type ShareClassView, type ValuationBasis, type ValuationView } from '@kaizen/shared';
import { api, date, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

const today = () => new Date().toISOString().slice(0, 10);

function NewValuation({ open, onClose, classes }: { open: boolean; onClose: () => void; classes: ShareClassView[] }) {
  const [asOf, setAsOf] = useState(today());
  const [basis, setBasis] = useState<ValuationBasis>('registered_valuer');
  const [valuerName, setValuerName] = useState('');
  const [equityValue, setEquityValue] = useState('');
  const [reportRef, setReportRef] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [perClass, setPerClass] = useState<Record<string, string>>({});

  return (
    <CreateModal
      open={open}
      title="Record a valuation"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['equity-valuations']]}
      onSubmit={() =>
        api.post('/equity/valuations', {
          asOf,
          basis,
          valuerName: valuerName || null,
          equityValue: equityValue ? Number(equityValue) : null,
          reportRef: reportRef || null,
          validUntil: validUntil || null,
          perShareByClass: Object.fromEntries(
            Object.entries(perClass)
              .filter(([, v]) => v !== '')
              .map(([k, v]) => [k, Number(v)]),
          ),
        })
      }
    >
      <Row>
        <TextInput label="As of" type="date" required value={asOf} onChange={setAsOf} />
        <SelectInput
          label="Basis"
          required
          value={basis}
          onChange={(v) => setBasis(v as ValuationBasis)}
          options={VALUATION_BASES.map((b) => ({ value: b, label: VALUATION_BASIS_LABELS[b] }))}
        />
      </Row>
      <Row>
        <TextInput label="Valuer" value={valuerName} onChange={setValuerName} />
        <TextInput label="Report reference" value={reportRef} onChange={setReportRef} />
      </Row>
      <Row>
        <MoneyInput label="Equity value" value={equityValue} onChange={setEquityValue} />
        <TextInput label="Valid until" type="date" value={validUntil} onChange={setValidUntil} />
      </Row>

      <fieldset className="rounded-lg border border-ink-800 p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Per-share value, by class</legend>
        <div className="flex flex-col gap-2">
          {classes.map((c) => (
            <MoneyInput
              key={c.id}
              label={c.name}
              value={perClass[c.id] ?? ''}
              onChange={(v) => setPerClass((p) => ({ ...p, [c.id]: v }))}
            />
          ))}
        </div>
      </fieldset>
    </CreateModal>
  );
}

export function Valuations() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-valuations'],
    queryFn: () => api.get<{ items: ValuationView[] }>('/equity/valuations'),
  });
  const { data: classes } = useQuery({
    queryKey: ['equity-share-classes'],
    queryFn: () => api.get<{ items: ShareClassView[] }>('/equity/share-classes'),
  });

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];
  const classById = new Map((classes?.items ?? []).map((c) => [c.id, c.name]));

  return (
    <div>
      <NewValuation open={creating} onClose={() => setCreating(false)} classes={classes?.items ?? []} />
      <PageHeader
        title="Valuations"
        subtitle="What a share was worth, as of when, and on what basis."
        actions={can('valuations:C') && <NewButton label="Record valuation" onClick={() => setCreating(true)} />}
      />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="No valuation on record." hint="Record one to give the cap table a per-share figure to show." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>As of</th>
                  <th>Basis</th>
                  <th>Valuer</th>
                  <th>Per share, by class</th>
                  <th className="text-right">Equity value</th>
                  <th>Report</th>
                  <th>Valid until</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td className="text-ink-100">{date(v.asOf)}</td>
                    <td className="text-ink-300">{VALUATION_BASIS_LABELS[v.basis]}</td>
                    <td className="text-2xs text-ink-400">{v.valuerName ?? '—'}</td>
                    <td className="text-2xs text-ink-400">
                      {Object.entries(v.perShareByClass)
                        .map(([classId, price]) => `${classById.get(classId) ?? classId}: ${money(price)}`)
                        .join(', ') || '—'}
                    </td>
                    <td className="text-right tabular-nums">{money(v.equityValue)}</td>
                    <td className="text-2xs text-ink-400">{v.reportRef ?? '—'}</td>
                    <td className="text-2xs text-ink-400">{v.validUntil ? date(v.validUntil) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
