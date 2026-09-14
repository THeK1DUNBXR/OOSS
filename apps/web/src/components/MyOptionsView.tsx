/**
 * "My Options" — an employee's own grants, wherever they are reached from:
 * `pages/MyOptions.tsx` (the ERP workspace) and `portal/pages/Options.tsx`
 * (an employee who is also a shareholder, from the portal shell) both render
 * this, so the content is the same sentence in both places rather than two
 * screens that quietly drift.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VestingTranche } from '@kaizen/shared';
import { api, date, money } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from './ui.js';
import { CreateModal, TextInput } from './forms.js';

interface MyGrantRow {
  id: string;
  recordCode: string;
  grantedOn: string;
  count: number;
  exercisePrice: number;
  vesting: { cliffMonths: number; schedule: VestingTranche[] };
  status: string;
  vested: number;
  exercised: number;
  lapsed: number;
  lapsedOn: string | null;
  exerciseWindowEndsOn: string | null;
  taxLine: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  proposed: 'accent',
  granted: 'neutral',
  partly_vested: 'accent',
  fully_vested: 'good',
  exercised: 'good',
  lapsed: 'bad',
  cancelled: 'bad',
};

function RequestExercise({ open, onClose, grant }: { open: boolean; onClose: () => void; grant: MyGrantRow }) {
  const available = grant.vested - grant.exercised;
  const [count, setCount] = useState(String(available));
  return (
    <CreateModal
      open={open}
      title={`Request exercise — ${grant.recordCode}`}
      submitLabel="Request it"
      onClose={onClose}
      invalidate={[['my-options']]}
      onSubmit={() => api.post('/esop/exercises', { grantId: grant.id, count: Number(count) })}
    >
      <p className="text-2xs text-ink-500">{available.toLocaleString('en-IN')} option(s) are vested and unexercised.</p>
      <TextInput label="Count" type="number" required value={count} onChange={setCount} />
    </CreateModal>
  );
}

function Tranches({ schedule }: { schedule: VestingTranche[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {schedule.map((t, i) => (
        <li key={i} className="flex items-center justify-between text-2xs">
          <span className="text-ink-400">{date(t.on)}</span>
          <span className="tabular-nums text-ink-200">{t.count.toLocaleString('en-IN')}</span>
        </li>
      ))}
    </ul>
  );
}

export function MyOptionsView() {
  const [requesting, setRequesting] = useState<MyGrantRow | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['my-options'],
    queryFn: () => api.get<{ items: MyGrantRow[] }>('/esop/me'),
  });

  if (loadError) return <ErrorBox error={loadError} />;

  const rows = data?.items ?? [];

  return (
    <div>
      {requesting && <RequestExercise open onClose={() => setRequesting(null)} grant={requesting} />}
      <PageHeader title="My options" />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="No options have been granted to you." />
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((g) => {
            const availableToExercise = g.vested - g.exercised;
            return (
              <Card key={g.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-ink-100">{g.recordCode}</p>
                    <p className="text-2xs text-ink-500">Granted {date(g.grantedOn)} · exercise price {money(g.exercisePrice)}</p>
                  </div>
                  <StatusChip status={g.status} tone={STATUS_TONE[g.status] ?? 'neutral'} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-4">
                  <div><span className="text-ink-500">Total</span><div className="tabular-nums text-ink-100">{g.count.toLocaleString('en-IN')}</div></div>
                  <div><span className="text-ink-500">Vested</span><div className="tabular-nums text-ink-100">{g.vested.toLocaleString('en-IN')}</div></div>
                  <div><span className="text-ink-500">Exercised</span><div className="tabular-nums text-ink-100">{g.exercised.toLocaleString('en-IN')}</div></div>
                  <div><span className="text-ink-500">Lapsed</span><div className="tabular-nums text-ink-100">{g.lapsed.toLocaleString('en-IN')}</div></div>
                </div>
                {g.exerciseWindowEndsOn && (
                  <p className="mt-2 text-2xs text-band-watch">Exercise window closes {date(g.exerciseWindowEndsOn)}.</p>
                )}
                <p className="mt-2 text-2xs text-ink-400">{g.taxLine}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-2xs text-accent-soft">Vesting timeline ({g.vesting.schedule.length})</summary>
                  <Tranches schedule={g.vesting.schedule} />
                </details>
                {availableToExercise > 0 && (
                  <div className="mt-3">
                    <button className="btn-primary" onClick={() => setRequesting(g)}>Request exercise</button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
