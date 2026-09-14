/**
 * Scenarios — "Model, not a record" (equity-portal plan §6 phase 4).
 *
 * A round model and a waterfall are hypotheses run against the live cap
 * table: the API computes them fresh on every request and writes nothing
 * (EQT-RND-008). Nothing on this screen is saveable, and it says so.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../../lib/api.js';
import { Card, ErrorBox, PageHeader } from '../../components/ui.js';
import { MoneyInput, Row, TextInput, messageOf } from '../../components/forms.js';

interface ModelRoundResult {
  postMoney: number;
  pricePerShare: number;
  newShares: number;
  poolTopUpShares: number;
  holders: Array<{
    holderId: string;
    holderName: string;
    before: { count: number; pct: number };
    after: { count: number; pct: number };
    dilutionPct: number;
  }>;
}

interface WaterfallResult {
  exitValue: number;
  rows: Array<{
    holderId: string;
    holderName: string;
    shareClassId: string;
    preferencePayout: number;
    commonPayout: number;
    totalPayout: number;
    converted: boolean;
  }>;
  unallocated: number;
}

function RoundModelPanel() {
  const [newMoney, setNewMoney] = useState('');
  const [preMoney, setPreMoney] = useState('');
  const [poolTopUpPct, setPoolTopUpPct] = useState('');
  const [className, setClassName] = useState('New round');
  const [liquidationMultiple, setLiquidationMultiple] = useState('1');
  const [seniority, setSeniority] = useState('0');
  const [participating, setParticipating] = useState(false);

  const model = useMutation({
    mutationFn: () =>
      api.post<ModelRoundResult>('/equity/scenarios/round', {
        newMoney: Number(newMoney),
        preMoney: Number(preMoney),
        newClass: {
          name: className,
          liquidationPreferenceMultiple: Number(liquidationMultiple),
          participating,
          seniority: Number(seniority),
        },
        optionPoolTopUpPct: poolTopUpPct ? Number(poolTopUpPct) : undefined,
      }),
  });

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Round model</h2>
      <p className="mb-3 text-2xs text-ink-500">
        A proposed round applied to the live cap table — every holder diluted by the same proportion of the
        pre-round total.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          model.mutate();
        }}
      >
        <Row>
          <MoneyInput label="New money" required value={newMoney} onChange={setNewMoney} />
          <MoneyInput label="Pre-money valuation" required value={preMoney} onChange={setPreMoney} />
        </Row>
        <Row>
          <TextInput label="New class name" value={className} onChange={setClassName} />
          <TextInput label="Option pool top-up %" type="number" value={poolTopUpPct} onChange={setPoolTopUpPct} />
        </Row>
        <Row>
          <TextInput label="Liquidation preference multiple" type="number" value={liquidationMultiple} onChange={setLiquidationMultiple} />
          <TextInput label="Seniority (0 = paid first)" type="number" value={seniority} onChange={setSeniority} />
        </Row>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={participating} onChange={(e) => setParticipating(e.target.checked)} />
          Participating
        </label>
        <button className="btn-primary self-start" type="submit" disabled={model.isPending}>
          {model.isPending ? 'Modelling…' : 'Model this round'}
        </button>
        {model.isError && <ErrorBox error={model.error} />}
      </form>

      {model.data && (
        <div className="mt-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="label">Post-money</div>
              <div className="num text-sm">{model.data.postMoney.toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div className="label">Price per share</div>
              <div className="num text-sm">{model.data.pricePerShare}</div>
            </div>
            <div>
              <div className="label">New shares</div>
              <div className="num text-sm">{model.data.newShares.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={model.data.holders} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" unit="%" />
                <YAxis type="category" dataKey="holderName" width={120} />
                <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} />
                <Bar dataKey="before.pct" name="Before" fill="#8f3d90" />
                <Bar dataKey="after.pct" name="After" fill="#2a78d6" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <table className="table mt-3">
            <thead>
              <tr>
                <th>Holder</th>
                <th className="text-right">Before %</th>
                <th className="text-right">After %</th>
                <th className="text-right">Dilution</th>
              </tr>
            </thead>
            <tbody>
              {model.data.holders.map((h) => (
                <tr key={h.holderId}>
                  <td>{h.holderName}</td>
                  <td className="text-right tabular-nums">{h.before.pct}</td>
                  <td className="text-right tabular-nums">{h.after.pct}</td>
                  <td className="text-right tabular-nums">{h.dilutionPct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function WaterfallPanel() {
  const [exitValue, setExitValue] = useState('');

  const model = useMutation({
    mutationFn: () => api.post<WaterfallResult>('/equity/scenarios/waterfall', { exitValue: Number(exitValue) }),
  });

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold">Waterfall</h2>
      <p className="mb-3 text-2xs text-ink-500">
        Distribution at an exit value — preference paid by seniority before common, each non-participating holder
        taking whichever of the preference or their as-converted share is larger.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          model.mutate();
        }}
      >
        <MoneyInput label="Exit value" required value={exitValue} onChange={setExitValue} />
        <button className="btn-primary self-start" type="submit" disabled={model.isPending}>
          {model.isPending ? 'Modelling…' : 'Model this exit'}
        </button>
        {model.isError && <ErrorBox error={model.error} />}
      </form>

      {model.data && (
        <table className="table mt-4">
          <thead>
            <tr>
              <th>Holder</th>
              <th className="text-right">Preference</th>
              <th className="text-right">Common</th>
              <th className="text-right">Total</th>
              <th>Converted</th>
            </tr>
          </thead>
          <tbody>
            {model.data.rows.map((r) => (
              <tr key={`${r.holderId}-${r.shareClassId}`}>
                <td>{r.holderName}</td>
                <td className="text-right tabular-nums">{r.preferencePayout.toLocaleString('en-IN')}</td>
                <td className="text-right tabular-nums">{r.commonPayout.toLocaleString('en-IN')}</td>
                <td className="text-right tabular-nums font-semibold">{r.totalPayout.toLocaleString('en-IN')}</td>
                <td className="text-2xs text-ink-400">{r.converted ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function Scenarios() {
  return (
    <div>
      <PageHeader
        title="Model — not a record"
        subtitle="A round model and a waterfall run against the live cap table on every request. Nothing here is saved."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <RoundModelPanel />
        <WaterfallPanel />
      </div>
    </div>
  );
}
