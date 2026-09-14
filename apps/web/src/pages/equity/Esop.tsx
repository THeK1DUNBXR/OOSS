/**
 * ESOP — the plan's pool bar, the grant register, and exercise requests.
 *
 * Table first (DESIGN.md): a plan's pool is a bar and four numbers, a grant is
 * a row with a status chip and a tranche popover, never a chart standing in
 * for the count somebody actually needs to read.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EsopPlanView, OptionGrantView, ShareClassView, VestingTranche } from '@kaizen/shared';
import { api, date, money } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, ContributionBar, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { CreateModal, MoneyInput, NewButton, Row, SelectInput, TextArea, TextInput, messageOf } from '../../components/forms.js';

const today = () => new Date().toISOString().slice(0, 10);

type PlanWithPool = EsopPlanView & {
  pool: { authorised: number | null; granted: number; vested: number; exercised: number; lapsed: number; available: number | null };
};

interface EmployeeOption {
  id: string;
  fullName: string;
  personId: string;
  status: string;
}

interface ExerciseRow {
  id: string;
  grantId: string;
  requestedOn: string;
  count: number;
  exercisePrice: number;
  fmvPerShare: number | null;
  fmvBasis: 'merchant_banker' | 'none';
  perquisite: number | null;
  perquisiteNote: string | null;
  taxDeferred: boolean;
  status: string;
}

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  draft: 'neutral',
  active: 'good',
  closed: 'neutral',
  proposed: 'accent',
  granted: 'neutral',
  partly_vested: 'accent',
  fully_vested: 'good',
  exercised: 'good',
  lapsed: 'bad',
  cancelled: 'bad',
  requested: 'accent',
  allotted: 'good',
  rejected: 'bad',
};

function useShareClasses() {
  return useQuery({
    queryKey: ['equity-share-classes', 'picker'],
    queryFn: () => api.get<{ items: ShareClassView[] }>('/equity/share-classes'),
  });
}

function useEmployees() {
  return useQuery({
    queryKey: ['hr-employees', 'picker'],
    queryFn: () => api.get<EmployeeOption[]>('/hr/employees'),
  });
}

function NewPlan({ open, onClose }: { open: boolean; onClose: () => void }) {
  const classes = useShareClasses();
  const [name, setName] = useState('');
  const [poolShareClassId, setPool] = useState('');
  const [targetShareClassId, setTarget] = useState('');
  const [exercisePriceDefault, setPrice] = useState('');
  const [cliffMonths, setCliff] = useState('12');
  const [totalMonths, setTotal] = useState('48');
  const [frequency, setFrequency] = useState<'monthly' | 'quarterly' | 'annual'>('quarterly');
  const [exerciseWindowMonthsAfterExit, setWindow] = useState('3');

  return (
    <CreateModal
      open={open}
      title="New ESOP plan"
      submitLabel="Create it"
      onClose={onClose}
      invalidate={[['esop-plans']]}
      onSubmit={() =>
        api.post('/esop/plans', {
          name,
          poolShareClassId,
          targetShareClassId,
          exercisePriceDefault: exercisePriceDefault ? Number(exercisePriceDefault) : null,
          vestingDefault: { cliffMonths: Number(cliffMonths), totalMonths: Number(totalMonths), frequency },
          exerciseWindowMonthsAfterExit: Number(exerciseWindowMonthsAfterExit),
        })
      }
    >
      <TextInput label="Name" required value={name} onChange={setName} />
      <Row>
        <SelectInput
          label="Pool class"
          required
          value={poolShareClassId}
          onChange={setPool}
          placeholder="A share class of instrument 'option'"
          options={(classes.data?.items ?? []).filter((c) => c.instrument === 'option').map((c) => ({ value: c.id, label: c.name }))}
        />
        <SelectInput
          label="Converts into"
          required
          value={targetShareClassId}
          onChange={setTarget}
          placeholder="The equity class an exercise allots into"
          options={(classes.data?.items ?? []).filter((c) => c.kind === 'equity').map((c) => ({ value: c.id, label: c.name }))}
        />
      </Row>
      <MoneyInput label="Default exercise price" value={exercisePriceDefault} onChange={setPrice} />
      <Row>
        <TextInput label="Cliff (months)" type="number" required value={cliffMonths} onChange={setCliff} />
        <TextInput label="Total vesting (months)" type="number" required value={totalMonths} onChange={setTotal} />
      </Row>
      <Row>
        <SelectInput
          label="Frequency"
          required
          value={frequency}
          onChange={(v) => setFrequency(v as never)}
          options={[
            { value: 'monthly', label: 'Monthly' },
            { value: 'quarterly', label: 'Quarterly' },
            { value: 'annual', label: 'Annual' },
          ]}
        />
        <TextInput label="Exercise window after exit (months)" type="number" required value={exerciseWindowMonthsAfterExit} onChange={setWindow} />
      </Row>
      <p className="text-2xs text-ink-500">
        First vesting must be at least 12 months after the grant (Rule 12). A cliff of {cliffMonths || '0'} month(s)
        {Number(cliffMonths) < 12 ? ' is short of that — activation and every grant under it will be refused.' : ' satisfies it.'}
      </p>
    </CreateModal>
  );
}

function ActivatePlan({ open, onClose, planId }: { open: boolean; onClose: () => void; planId: string }) {
  const [approvedOn, setApprovedOn] = useState(today());
  const [resolutionRef, setResolutionRef] = useState('');
  const [mgt14Srn, setMgt14Srn] = useState('');
  return (
    <CreateModal
      open={open}
      title="Activate this plan"
      submitLabel="Activate it"
      onClose={onClose}
      invalidate={[['esop-plans']]}
      onSubmit={() => api.post(`/esop/plans/${planId}/activate`, { approvedOn, resolutionRef, mgt14Srn: mgt14Srn || null })}
    >
      <p className="text-2xs text-ink-500">Rule 12: a scheme needs its own shareholder resolution before any grant is proposed under it.</p>
      <TextInput label="Resolution date" type="date" required value={approvedOn} onChange={setApprovedOn} />
      <TextInput label="Resolution reference" required value={resolutionRef} onChange={setResolutionRef} />
      <TextInput label="MGT-14 SRN" value={mgt14Srn} onChange={setMgt14Srn} />
    </CreateModal>
  );
}

function NewGrant({ open, onClose, plans }: { open: boolean; onClose: () => void; plans: PlanWithPool[] }) {
  const employees = useEmployees();
  const [planId, setPlanId] = useState('');
  const [employmentId, setEmploymentId] = useState('');
  const [grantedOn, setGrantedOn] = useState(today());
  const [count, setCount] = useState('');
  const [exercisePrice, setExercisePrice] = useState('');
  const [cliffMonths, setCliffMonths] = useState('');
  const [totalMonths, setTotalMonths] = useState('');
  const [frequency, setFrequency] = useState<'monthly' | 'quarterly' | 'annual' | ''>('');
  const [resolutionRef, setResolutionRef] = useState('');
  const [grantLetterRef, setGrantLetterRef] = useState('');

  const activePlans = plans.filter((p) => p.status === 'active');
  const override = cliffMonths || totalMonths || frequency;

  return (
    <CreateModal
      open={open}
      title="New grant"
      submitLabel="Propose it"
      onClose={onClose}
      invalidate={[['esop-grants'], ['esop-plans']]}
      onSubmit={() =>
        api.post('/esop/grants', {
          planId,
          employmentId,
          grantedOn,
          count: Number(count),
          exercisePrice: exercisePrice ? Number(exercisePrice) : null,
          vestingOverride: override
            ? { cliffMonths: Number(cliffMonths), totalMonths: Number(totalMonths), frequency: frequency || 'quarterly' }
            : null,
          resolutionRef: resolutionRef || null,
          grantLetterRef: grantLetterRef || null,
        })
      }
    >
      <SelectInput
        label="Plan"
        required
        value={planId}
        onChange={setPlanId}
        placeholder="Choose an active plan"
        options={activePlans.map((p) => ({ value: p.id, label: `${p.name} (${p.pool.available ?? '?'} available)` }))}
      />
      <SelectInput
        label="Employee"
        required
        value={employmentId}
        onChange={setEmploymentId}
        placeholder="Who this grant is for"
        options={(employees.data ?? []).map((e) => ({ value: e.id, label: e.fullName }))}
      />
      <Row>
        <TextInput label="Granted on" type="date" required value={grantedOn} onChange={setGrantedOn} />
        <TextInput label="Count" type="number" required value={count} onChange={setCount} />
      </Row>
      <MoneyInput label="Exercise price" value={exercisePrice} onChange={setExercisePrice} hint="leave blank to use the plan default" />
      <p className="text-2xs text-ink-500">Vesting override — leave every field blank to use the plan's own schedule.</p>
      <Row>
        <TextInput label="Cliff (months)" type="number" value={cliffMonths} onChange={setCliffMonths} />
        <TextInput label="Total vesting (months)" type="number" value={totalMonths} onChange={setTotalMonths} />
      </Row>
      <SelectInput
        label="Frequency"
        value={frequency}
        onChange={(v) => setFrequency(v as never)}
        placeholder="Plan default"
        options={[
          { value: 'monthly', label: 'Monthly' },
          { value: 'quarterly', label: 'Quarterly' },
          { value: 'annual', label: 'Annual' },
        ]}
      />
      <p className="text-2xs text-ink-500">
        First vesting must be at least 12 months after the grant (Rule 12){cliffMonths ? ` — a cliff of ${cliffMonths} month(s) ${Number(cliffMonths) < 12 ? 'will be refused.' : 'satisfies it.'}` : '.'}
      </p>
      <TextInput label="Resolution reference" value={resolutionRef} onChange={setResolutionRef} hint="needed if this grant is ≥1% of issued capital" />
      <TextInput label="Grant letter reference" value={grantLetterRef} onChange={setGrantLetterRef} />
    </CreateModal>
  );
}

function ReasonModal({
  open, title, submitLabel, onClose, onSubmit,
}: {
  open: boolean; title: string; submitLabel: string; onClose: () => void; onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  return (
    <CreateModal open={open} title={title} submitLabel={submitLabel} onClose={onClose} invalidate={[['esop-grants']]} onSubmit={() => onSubmit(reason)}>
      <TextArea label="Reason" required value={reason} onChange={setReason} rows={3} />
    </CreateModal>
  );
}

function TranchePopover({ tranches }: { tranches: VestingTranche[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button type="button" className="text-2xs text-accent-soft underline decoration-dotted" onClick={() => setOpen((v) => !v)}>
        {tranches.length} tranche{tranches.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-10 w-56 rounded-md border border-ink-800 bg-ink-900 p-2 shadow-floating">
          {tranches.map((t, i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-0.5 text-2xs">
              <span className="text-ink-400">{date(t.on)}</span>
              <span className="tabular-nums text-ink-200">{t.count.toLocaleString('en-IN')}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

function PlanCard({ p, onActivate }: { p: PlanWithPool; onActivate: () => void }) {
  const { can } = useSession();
  const { authorised, granted, vested, exercised, lapsed, available } = p.pool;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink-100">{p.name}</p>
          <p className="text-2xs text-ink-500">{p.recordCode}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip status={p.status} tone={STATUS_TONE[p.status]} />
          {p.status === 'draft' && can('esop_plans:approve') && <NewButton label="Activate" onClick={onActivate} />}
        </div>
      </div>
      <div className="mt-3">
        <ContributionBar value={authorised != null ? authorised - (available ?? 0) : 0} max={authorised ?? 0} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-5">
        <div><span className="text-ink-500">Authorised</span><div className="tabular-nums text-ink-100">{authorised ?? 'Not set'}</div></div>
        <div><span className="text-ink-500">Granted</span><div className="tabular-nums text-ink-100">{granted.toLocaleString('en-IN')}</div></div>
        <div><span className="text-ink-500">Vested</span><div className="tabular-nums text-ink-100">{vested.toLocaleString('en-IN')}</div></div>
        <div><span className="text-ink-500">Exercised</span><div className="tabular-nums text-ink-100">{exercised.toLocaleString('en-IN')}</div></div>
        <div><span className="text-ink-500">Lapsed</span><div className="tabular-nums text-ink-100">{lapsed.toLocaleString('en-IN')}</div></div>
      </div>
      <p className="mt-2 text-2xs text-ink-500">
        Available: {available != null ? available.toLocaleString('en-IN') : 'Not set'} · {p.isDpiitRecognised ? 'DPIIT-recognised' : 'Not DPIIT-recognised'}
      </p>
    </Card>
  );
}

export function Esop() {
  const { can, user } = useSession();
  const qc = useQueryClient();
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [activating, setActivating] = useState<string | null>(null);
  const [creatingGrant, setCreatingGrant] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [lapsing, setLapsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plans = useQuery({ queryKey: ['esop-plans'], queryFn: () => api.get<{ items: PlanWithPool[] }>('/esop/plans') });
  const grants = useQuery({ queryKey: ['esop-grants'], queryFn: () => api.get<{ items: OptionGrantView[] }>('/esop/grants') });
  const exercises = useQuery({ queryKey: ['esop-exercises'], queryFn: () => api.get<{ items: ExerciseRow[] }>('/esop/exercises') });
  const employees = useEmployees();

  const act = useMutation({
    mutationFn: (input: { id: string; path: string }) => api.post(`/esop/grants/${input.id}/${input.path}`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['esop-grants'] });
      qc.invalidateQueries({ queryKey: ['esop-plans'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const approveExercise = useMutation({
    mutationFn: (id: string) => api.post(`/esop/exercises/${id}/approve`),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['esop-exercises'] });
      qc.invalidateQueries({ queryKey: ['esop-grants'] });
    },
    onError: (e) => setError(messageOf(e)),
  });

  if (plans.error) return <ErrorBox error={plans.error} />;

  const employeeName = (employmentId: string) => employees.data?.find((e) => e.id === employmentId)?.fullName ?? employmentId;
  const planName = (planId: string) => plans.data?.items.find((p) => p.id === planId)?.name ?? planId;

  const pendingExercises = (exercises.data?.items ?? []).filter((x) => x.status === 'requested');

  return (
    <div className="space-y-6">
      <NewPlan open={creatingPlan} onClose={() => setCreatingPlan(false)} />
      {activating && <ActivatePlan open onClose={() => setActivating(null)} planId={activating} />}
      <NewGrant open={creatingGrant} onClose={() => setCreatingGrant(false)} plans={plans.data?.items ?? []} />
      {cancelling && (
        <ReasonModal
          open
          title="Cancel this grant"
          submitLabel="Cancel it"
          onClose={() => setCancelling(null)}
          onSubmit={async (reason) => {
            await api.post(`/esop/grants/${cancelling}/cancel`, { reason });
            setCancelling(null);
            qc.invalidateQueries({ queryKey: ['esop-plans'] });
          }}
        />
      )}
      {lapsing && (
        <ReasonModal
          open
          title="Lapse this grant"
          submitLabel="Lapse it"
          onClose={() => setLapsing(null)}
          onSubmit={async (reason) => {
            await api.post(`/esop/grants/${lapsing}/lapse`, { reason });
            setLapsing(null);
            qc.invalidateQueries({ queryKey: ['esop-plans'] });
          }}
        />
      )}

      <PageHeader
        title="ESOP"
        subtitle="Plans, grants, vesting and exercises."
        actions={
          <>
            {can('esop_plans:create') && <NewButton label="New plan" onClick={() => setCreatingPlan(true)} />}
            {can('option_grants:create') && <NewButton label="New grant" onClick={() => setCreatingGrant(true)} />}
            {can('esop_plans:view') && (
              <button className="btn-ghost" onClick={() => api.download('/esop/register/sh-6.xlsx', 'sh-6-register.xlsx')}>
                Download SH-6 register
              </button>
            )}
          </>
        }
      />

      {error && (
        <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">{error}</p>
      )}

      {plans.isLoading ? (
        <Loading />
      ) : (plans.data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState message="No ESOP plan exists yet." hint="Create one, then activate it with its shareholder resolution before proposing a grant." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {plans.data!.items.map((p) => (
            <PlanCard key={p.id} p={p} onActivate={() => setActivating(p.id)} />
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink-100">Grants</h2>
        {grants.isLoading ? (
          <Loading />
        ) : (grants.data?.items.length ?? 0) === 0 ? (
          <Card>
            <EmptyState message="No options have been granted yet." />
          </Card>
        ) : (
          <Card bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Grantee</th>
                    <th>Plan</th>
                    <th>Granted on</th>
                    <th className="text-right">Count</th>
                    <th className="text-right">Price</th>
                    <th>Vested / exercised / lapsed</th>
                    <th>Tranches</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {grants.data!.items.map((g) => {
                    const isOwnProposal = user && g.proposedByPartyId === user.personId;
                    const isGrantee = user && g.personId === user.personId;
                    return (
                      <tr key={g.id}>
                        <td className="text-ink-100">{employeeName(g.employmentId)}</td>
                        <td className="text-ink-300">{planName(g.planId)}</td>
                        <td className="text-2xs text-ink-400">{date(g.grantedOn)}</td>
                        <td className="text-right tabular-nums">{g.count.toLocaleString('en-IN')}</td>
                        <td className="text-right tabular-nums">{money(g.exercisePrice)}</td>
                        <td className="text-2xs tabular-nums text-ink-400">
                          {g.vested.toLocaleString('en-IN')} / {g.exercised.toLocaleString('en-IN')} / {g.lapsed.toLocaleString('en-IN')}
                        </td>
                        <td><TranchePopover tranches={g.vesting.schedule} /></td>
                        <td>
                          <StatusChip status={g.status} tone={STATUS_TONE[g.status]} />
                          {isOwnProposal && g.status === 'proposed' && (
                            <p className="mt-1 text-2xs italic text-ink-500">You proposed this; another approver must act.</p>
                          )}
                          {isGrantee && g.status === 'proposed' && (
                            <p className="mt-1 text-2xs italic text-ink-500">You cannot approve your own grant.</p>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-1">
                            {g.status === 'proposed' && !isOwnProposal && !isGrantee && can('option_grants:approve') && (
                              <button className="btn-ghost" onClick={() => act.mutate({ id: g.id, path: 'approve' })}>Approve</button>
                            )}
                            {g.status === 'proposed' && can('option_grants:edit') && (
                              <button className="btn-ghost" onClick={() => setCancelling(g.id)}>Cancel</button>
                            )}
                            {['granted', 'partly_vested', 'fully_vested'].includes(g.status) && can('option_grants:edit') && (
                              <button className="btn-ghost" onClick={() => setLapsing(g.id)}>Lapse</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {can('option_grants:approve') && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-ink-100">Exercise requests</h2>
          {pendingExercises.length === 0 ? (
            <Card><EmptyState message="No exercise requests are waiting." /></Card>
          ) : (
            <Card bodyClassName="p-0">
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Grant</th>
                      <th>Requested on</th>
                      <th className="text-right">Count</th>
                      <th className="text-right">FMV</th>
                      <th className="text-right">Perquisite</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pendingExercises.map((x) => (
                      <tr key={x.id}>
                        <td className="mono text-2xs">{x.grantId}</td>
                        <td className="text-2xs text-ink-400">{date(x.requestedOn)}</td>
                        <td className="text-right tabular-nums">{x.count.toLocaleString('en-IN')}</td>
                        <td className="text-right tabular-nums">{x.fmvBasis === 'merchant_banker' ? money(x.fmvPerShare) : 'Not available'}</td>
                        <td className="text-right tabular-nums">{x.perquisite != null ? money(x.perquisite) : x.perquisiteNote}</td>
                        <td className="text-right">
                          <button className="btn-ghost" onClick={() => approveExercise.mutate(x.id)}>Approve &amp; allot</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
