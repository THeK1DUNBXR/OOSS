/**
 * ESOP (bounded context `eqt`) — equity-portal plan §5/§6, phase 5.
 *
 * A grant vests into tranches, and an exercise allots shares out of the pool
 * `ShareClass` through the exact path phase 1 built for a manual allotment —
 * `equity.ts`'s `makeEffective`, via the internal `recordExerciseAllotment` /
 * `holderForExercise` pair it exports for this file to call, gated on
 * `share_ledger:approve` (the grant the exercise's own approver already
 * holds) rather than the register keeper's `share_ledger:create`.
 *
 * A perquisite is computed only from a merchant-banker `Valuation` recorded
 * within 180 days of the exercise request (Rule 3(8)); without one the figure
 * is withheld and the reason is named, never left at zero.
 */

import * as XLSX from 'xlsx';
import {
  EVENTS,
  ESOP_MIN_CLIFF_MONTHS,
  ESOP_SINGLE_GRANT_RESOLUTION_THRESHOLD_PCT,
  ESOP_FMV_VALIDITY_DAYS,
  isEmployed,
  esopTaxLine,
  firstVestingIsRuleTwelveCompliant,
  generateVestingTranches,
  type EmploymentState,
  type VestingScheduleInput,
  type VestingTranche,
  type PromoterCheck,
} from '@kaizen/shared';
import { prisma, dec, num } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan, assertScopeAll, scopeFor } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { companyProfile } from './companyProfile.js';
import { evaluateApprovalGate } from '../platform/approvals.js';
import { holderForExercise, recordExerciseAllotment, makeEffective } from './equity.js';

registerGovernedEntities('eqt', ['esop_plan', 'option_grant', 'vesting_event', 'option_exercise']);

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface EsopPlanInput {
  name: string;
  poolShareClassId: string;
  targetShareClassId: string;
  exercisePriceDefault?: number | null;
  vestingDefault: VestingScheduleInput;
  exerciseWindowMonthsAfterExit?: number;
}

export async function createPlan(input: EsopPlanInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'esop_plans', verb: 'create' });

  const pool = await prisma.shareClass.findFirst({ where: { id: input.poolShareClassId, tenantId: auth.tenantId } });
  if (!pool) throw ApiError.notFound('Share class');
  if (pool.instrument !== 'option') {
    throw ApiError.badRequest(`The plan's pool must be a share class of instrument "option"; ${pool.name} is "${pool.instrument}".`);
  }
  const target = await prisma.shareClass.findFirst({ where: { id: input.targetShareClassId, tenantId: auth.tenantId } });
  if (!target) throw ApiError.notFound('Share class');

  if (!firstVestingIsRuleTwelveCompliant(input.vestingDefault)) {
    throw ApiError.unprocessable(
      `Rule 12 of the Companies (Share Capital and Debentures) Rules, 2014 requires at least one year between the grant date and the first vesting. ` +
        `A default cliff of ${input.vestingDefault.cliffMonths} months is short of that.`,
    );
  }

  const profile = await companyProfile();

  const row = await prisma.esopPlan.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('ESP'),
      name: input.name,
      poolShareClassId: input.poolShareClassId,
      targetShareClassId: input.targetShareClassId,
      isDpiitRecognised: Boolean(profile.dpiitRecognisedOn),
      exercisePriceDefault: input.exercisePriceDefault == null ? null : dec(input.exercisePriceDefault),
      vestingDefault: input.vestingDefault as never,
      exerciseWindowMonthsAfterExit: input.exerciseWindowMonthsAfterExit ?? 3,
      status: 'draft',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'esop_plan', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.ESOP_PLAN_CREATED,
    subject: { entityType: 'esop_plan', entityId: row.id, recordCode: row.recordCode },
    newState: { name: row.name, poolShareClassId: row.poolShareClassId },
  });

  return planView(row);
}

export interface ActivatePlanInput {
  approvedOn: string;
  resolutionRef: string;
  mgt14Srn?: string | null;
}

/** Rule 12: the scheme itself needs a separate shareholder resolution, recorded here rather than workflowed. */
export async function activatePlan(id: string, input: ActivatePlanInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'esop_plans', verb: 'approve' });

  const existing = await prisma.esopPlan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('ESOP plan');
  if (existing.status !== 'draft') throw ApiError.conflict(`This plan is already ${existing.status}.`);
  if (!input.approvedOn || !input.resolutionRef) {
    throw ApiError.badRequest('Activating a plan needs the shareholder resolution date and its reference (Rule 12).');
  }

  const updated = await prisma.esopPlan.update({
    where: { id },
    data: {
      status: 'active',
      approvedOn: new Date(input.approvedOn),
      resolutionRef: input.resolutionRef,
      mgt14Srn: input.mgt14Srn ?? null,
    },
  });

  await auditWrite({ action: 'update', subjectType: 'esop_plan', subjectId: id, before: existing as never, after: updated as never });
  await emit({
    name: EVENTS.ESOP_PLAN_ACTIVATED,
    subject: { entityType: 'esop_plan', entityId: id, recordCode: existing.recordCode },
    newState: { status: 'active', resolutionRef: input.resolutionRef },
  });

  return planView(updated);
}

async function poolStats(plan: { id: string; poolShareClassId: string }) {
  const auth = currentAuth();
  const [pool, grants] = await Promise.all([
    prisma.shareClass.findFirst({ where: { id: plan.poolShareClassId, tenantId: auth.tenantId } }),
    prisma.optionGrant.findMany({ where: { tenantId: auth.tenantId, planId: plan.id, status: { not: 'cancelled' } } }),
  ]);

  const authorised = num(pool?.authorisedCount as never);
  const granted = grants.reduce((s, g) => s + (num(g.count) ?? 0), 0);
  const vested = grants.reduce((s, g) => s + (num(g.vested) ?? 0), 0);
  const exercised = grants.reduce((s, g) => s + (num(g.exercised) ?? 0), 0);
  const lapsed = grants.reduce((s, g) => s + (num(g.lapsed) ?? 0), 0);
  const reserved = granted - exercised - lapsed;
  const available = authorised == null ? null : authorised - reserved;

  return { authorised, granted, vested, exercised, lapsed, available };
}

function planView(row: {
  id: string; recordCode: string; name: string; poolShareClassId: string; targetShareClassId: string;
  approvedOn: Date | null; resolutionRef: string | null; mgt14Srn: string | null; isDpiitRecognised: boolean;
  exercisePriceDefault: unknown; vestingDefault: unknown; exerciseWindowMonthsAfterExit: number; status: string;
}) {
  return {
    id: row.id,
    recordCode: row.recordCode,
    name: row.name,
    poolShareClassId: row.poolShareClassId,
    targetShareClassId: row.targetShareClassId,
    approvedOn: row.approvedOn ? row.approvedOn.toISOString() : null,
    resolutionRef: row.resolutionRef,
    mgt14Srn: row.mgt14Srn,
    isDpiitRecognised: row.isDpiitRecognised,
    exercisePriceDefault: num(row.exercisePriceDefault as never),
    vestingDefault: row.vestingDefault as VestingScheduleInput,
    exerciseWindowMonthsAfterExit: row.exerciseWindowMonthsAfterExit,
    status: row.status as 'draft' | 'active' | 'closed',
  };
}

export async function listPlans() {
  const auth = currentAuth();
  await assertScopeAll('esop_plans');
  const rows = await prisma.esopPlan.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
  return Promise.all(rows.map(async (r) => ({ ...planView(r), pool: await poolStats(r) })));
}

export async function plan(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'esop_plans', verb: 'view' });
  const row = await prisma.esopPlan.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('ESOP plan');
  return { ...planView(row), pool: await poolStats(row) };
}

// ---------------------------------------------------------------------------
// Promoter / >10% check
// ---------------------------------------------------------------------------

/**
 * The share of issued capital (equity + preference, s.2(87)) this person
 * holds, directly or through an organisation holder they are an active
 * contact of — the same "own holder" reach `equity.ts`'s `isOwnHolder` grants
 * a viewer, read here the other way round: which holders this person reaches.
 */
async function personEquityPct(personId: string): Promise<number> {
  const auth = currentAuth();
  const shareCapitalClasses = await prisma.shareClass.findMany({
    where: { tenantId: auth.tenantId, kind: { in: ['equity', 'preference'] } },
    select: { id: true },
  });
  const classIds = shareCapitalClasses.map((c) => c.id);
  if (classIds.length === 0) return 0;

  const [orgAffiliations, personHolder, orgHolders, transactions] = await Promise.all([
    prisma.affiliation.findMany({ where: { tenantId: auth.tenantId, partyId: personId, status: 'active' }, select: { counterpartyId: true } }),
    prisma.holder.findFirst({ where: { tenantId: auth.tenantId, kind: 'person', personId } }),
    prisma.holder.findMany({ where: { tenantId: auth.tenantId, kind: 'organization' } }),
    prisma.shareTransaction.findMany({ where: { tenantId: auth.tenantId, status: 'effective', shareClassId: { in: classIds } } }),
  ]);

  const orgIds = new Set(orgAffiliations.map((a) => a.counterpartyId).filter((v): v is string => Boolean(v)));
  const reachedHolderIds = new Set<string>();
  if (personHolder) reachedHolderIds.add(personHolder.id);
  for (const h of orgHolders) if (h.organizationId && orgIds.has(h.organizationId)) reachedHolderIds.add(h.id);

  let mine = 0;
  let total = 0;
  for (const t of transactions) {
    const amount = num(t.count) ?? 0;
    if (t.toHolderId) {
      total += amount;
      if (reachedHolderIds.has(t.toHolderId)) mine += amount;
    }
    if (t.fromHolderId) {
      total -= amount;
      if (reachedHolderIds.has(t.fromHolderId)) mine -= amount;
    }
  }
  if (total <= 0) return 0;
  return (mine / total) * 100;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export interface ProposeGrantInput {
  planId: string;
  employmentId: string;
  grantedOn: string;
  count: number;
  exercisePrice?: number | null;
  vestingOverride?: VestingScheduleInput | null;
  grantLetterRef?: string | null;
  resolutionRef?: string | null;
}

export async function proposeGrant(input: ProposeGrantInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'create' });

  const planRow = await prisma.esopPlan.findFirst({ where: { id: input.planId, tenantId: auth.tenantId } });
  if (!planRow) throw ApiError.notFound('ESOP plan');
  if (planRow.status !== 'active') throw ApiError.unprocessable(`The plan is ${planRow.status}; a grant can only be proposed under an active plan.`);

  const employment = await prisma.employmentRelationship.findFirst({ where: { id: input.employmentId, tenantId: auth.tenantId } });
  if (!employment) throw ApiError.notFound('Employment relationship');
  if (!isEmployed(employment.status as EmploymentState)) {
    throw ApiError.unprocessable(`${employment.recordCode} is ${employment.status}; a grant cannot be proposed against an employment that has already ended.`);
  }

  if (input.count <= 0) throw ApiError.badRequest('A grant must be for a positive number of options.');

  const { available } = await poolStats(planRow);
  if (available != null && input.count > available) {
    throw ApiError.unprocessable(
      `This grant of ${input.count} options would exceed the pool: only ${available} are available under ${planRow.recordCode} — an over-allocation.`,
    );
  }

  const schedule = input.vestingOverride ?? (planRow.vestingDefault as never as VestingScheduleInput);
  if (!firstVestingIsRuleTwelveCompliant(schedule)) {
    throw ApiError.unprocessable(
      `Rule 12 of the Companies (Share Capital and Debentures) Rules, 2014 requires at least ${ESOP_MIN_CLIFF_MONTHS} months between the grant date and ` +
        `the first vesting event. This schedule's cliff is ${schedule.cliffMonths} months.`,
    );
  }

  const equityPct = await personEquityPct(employment.personId);
  const holdsOver10Pct = equityPct > 10;
  const promoterCheck: PromoterCheck = {
    // No separate promoter register exists in this platform yet; Rule
    // 12(1)(c)'s exclusion is applied here on the same test the rule itself
    // names for a promoter group — holding more than ten percent, directly
    // or through a holder represented — rather than left unenforced for
    // want of a promoter flag.
    isPromoterOrPromoterGroup: holdsOver10Pct,
    holdsOver10Pct,
    dpiitReliefApplied: false,
  };
  if (holdsOver10Pct && !planRow.isDpiitRecognised) {
    throw ApiError.unprocessable(
      `Rule 12(1)(c) excludes a promoter or a person holding more than ten percent of the equity share capital from an ESOP grant, ` +
        `unless the company is DPIIT-recognised. This plan is not, and this person holds ${equityPct.toFixed(2)}% of the equity share capital.`,
    );
  }
  if (holdsOver10Pct) promoterCheck.dpiitReliefApplied = true;

  const issuedTotal = await issuedShareCapitalTotal();
  const grantPct = issuedTotal > 0 ? (input.count / issuedTotal) * 100 : 0;
  const resolutionRef = input.resolutionRef ?? null;
  if (grantPct >= ESOP_SINGLE_GRANT_RESOLUTION_THRESHOLD_PCT && !resolutionRef) {
    throw ApiError.unprocessable(
      `Rule 12(4) requires its own shareholder resolution for a single grant of one percent or more of the issued capital. ` +
        `This grant is ${grantPct.toFixed(2)}% — pass a resolutionRef.`,
    );
  }

  const exercisePrice = input.exercisePrice ?? num(planRow.exercisePriceDefault as never);
  if (exercisePrice == null) throw ApiError.badRequest('An exercise price is required — either on this grant or as the plan default.');

  const tranches = generateVestingTranches(input.grantedOn, input.count, schedule);

  const row = await prisma.optionGrant.create({
    data: {
      tenantId: auth.tenantId,
      recordCode: await nextRecordCode('OPG'),
      planId: input.planId,
      employmentId: input.employmentId,
      personId: employment.personId,
      grantedOn: new Date(input.grantedOn),
      count: dec(input.count)!,
      exercisePrice: dec(exercisePrice)!,
      vesting: { cliffMonths: schedule.cliffMonths, schedule: tranches } as never,
      grantLetterRef: input.grantLetterRef ?? null,
      status: 'proposed',
      promoterCheck: promoterCheck as never,
      resolutionRef,
      proposedByPartyId: auth.partyId ?? 'system',
    },
  });

  await prisma.vestingEvent.createMany({
    data: tranches.map((t: VestingTranche) => ({
      tenantId: auth.tenantId,
      grantId: row.id,
      on: new Date(t.on),
      count: dec(t.count)!,
      status: 'scheduled',
    })),
  });

  await auditWrite({ action: 'create', subjectType: 'option_grant', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.OPTION_PROPOSED,
    subject: { entityType: 'option_grant', entityId: row.id, recordCode: row.recordCode },
    newState: { planId: row.planId, personId: row.personId, count: input.count },
  });

  return grantView(row, tranches);
}

async function issuedShareCapitalTotal(): Promise<number> {
  const auth = currentAuth();
  const classes = await prisma.shareClass.findMany({ where: { tenantId: auth.tenantId, kind: { in: ['equity', 'preference'] } }, select: { id: true } });
  const classIds = classes.map((c) => c.id);
  if (classIds.length === 0) return 0;
  const agg = await prisma.shareTransaction.aggregate({
    where: { tenantId: auth.tenantId, status: 'effective', shareClassId: { in: classIds }, toHolderId: { not: null } },
    _sum: { count: true },
  });
  const outAgg = await prisma.shareTransaction.aggregate({
    where: { tenantId: auth.tenantId, status: 'effective', shareClassId: { in: classIds }, fromHolderId: { not: null } },
    _sum: { count: true },
  });
  return (num(agg._sum.count) ?? 0) - (num(outAgg._sum.count) ?? 0);
}

/**
 * The approval gate: the self-dealing bar (via `ownerPartyId: grant.personId`)
 * refuses the grantee approving their own grant; the proposer is refused
 * explicitly, the same way `equity.ts`'s `approveShareTransaction` refuses
 * its own proposer before the gate is even consulted.
 */
export async function approveGrant(id: string) {
  const auth = currentAuth();
  const grant = await prisma.optionGrant.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!grant) throw ApiError.notFound('Option grant');
  if (grant.status !== 'proposed') throw ApiError.conflict(`This grant is already ${grant.status}.`);

  if (grant.proposedByPartyId === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: the proposer of a grant may never approve it.');
  }

  const value = (num(grant.exercisePrice) ?? 0) * (num(grant.count) ?? 0);
  const result = await evaluateApprovalGate(
    'POL-EQT-OPTION-GRANT-APPROVAL',
    {
      id: grant.id,
      type: 'option_grant',
      resource: 'option_grants',
      label: grant.recordCode,
      ownerPartyId: grant.personId,
      commercialValue: value,
      currency: 'INR',
      strategicValue: null,
      termMonths: null,
    },
    'approve',
  );
  if (!result.permitted) {
    throw ApiError.forbidden(result.reason, [{ axis: 'WHO', passed: false, reason: 'self_dealing_or_authority' }]);
  }

  const updated = await prisma.optionGrant.update({ where: { id }, data: { status: 'granted', approvedByPartyId: auth.partyId ?? 'system' } });
  await auditWrite({ action: 'update', subjectType: 'option_grant', subjectId: id, before: grant as never, after: updated as never });
  await emit({
    name: EVENTS.OPTION_GRANTED,
    subject: { entityType: 'option_grant', entityId: id, recordCode: grant.recordCode },
    newState: { status: 'granted' },
  });

  return grantView(updated);
}

export async function cancelGrant(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'edit' });

  const grant = await prisma.optionGrant.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!grant) throw ApiError.notFound('Option grant');
  if (['exercised', 'lapsed', 'cancelled'].includes(grant.status)) throw ApiError.conflict(`This grant is already ${grant.status}.`);
  if ((num(grant.vested) ?? 0) > 0) {
    throw ApiError.unprocessable('This grant has already vested in part and can no longer be cancelled outright — lapse the unexercised balance instead.');
  }

  const updated = await prisma.optionGrant.update({ where: { id }, data: { status: 'cancelled' } });
  await prisma.vestingEvent.updateMany({ where: { tenantId: auth.tenantId, grantId: id, status: 'scheduled' }, data: { status: 'lapsed' } });

  await auditWrite({ action: 'update', subjectType: 'option_grant', subjectId: id, before: grant as never, after: updated as never });
  await emit({
    name: EVENTS.OPTION_CANCELLED,
    subject: { entityType: 'option_grant', entityId: id, recordCode: grant.recordCode },
    newState: { status: 'cancelled', reason },
  });

  return grantView(updated);
}

export async function lapseGrant(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'edit' });

  const grant = await prisma.optionGrant.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!grant) throw ApiError.notFound('Option grant');
  if (['exercised', 'lapsed', 'cancelled'].includes(grant.status)) throw ApiError.conflict(`This grant is already ${grant.status}.`);

  const remaining = (num(grant.count) ?? 0) - (num(grant.exercised) ?? 0) - (num(grant.lapsed) ?? 0);
  const updated = await prisma.optionGrant.update({
    where: { id },
    data: { status: 'lapsed', lapsed: dec((num(grant.lapsed) ?? 0) + remaining)!, lapsedOn: new Date(), lapseReason: reason },
  });
  await prisma.vestingEvent.updateMany({ where: { tenantId: auth.tenantId, grantId: id, status: 'scheduled' }, data: { status: 'lapsed' } });

  await auditWrite({ action: 'update', subjectType: 'option_grant', subjectId: id, before: grant as never, after: updated as never });
  await emit({
    name: EVENTS.OPTION_LAPSED,
    subject: { entityType: 'option_grant', entityId: id, recordCode: grant.recordCode },
    newState: { status: 'lapsed', reason, count: remaining },
  });

  return grantView(updated);
}

function grantView(
  row: {
    id: string; recordCode: string; planId: string; employmentId: string; personId: string; grantedOn: Date;
    count: unknown; exercisePrice: unknown; vesting: unknown; grantLetterRef: string | null; status: string;
    vested: unknown; exercised: unknown; lapsed: unknown; lapsedOn: Date | null; lapseReason: string | null;
    exerciseWindowEndsOn: Date | null; promoterCheck: unknown; resolutionRef: string | null;
    proposedByPartyId: string; approvedByPartyId: string | null;
  },
  tranchesOverride?: VestingTranche[],
) {
  const vesting = row.vesting as { cliffMonths: number; schedule: VestingTranche[] };
  return {
    id: row.id,
    recordCode: row.recordCode,
    planId: row.planId,
    employmentId: row.employmentId,
    personId: row.personId,
    grantedOn: row.grantedOn.toISOString(),
    count: num(row.count as never)!,
    exercisePrice: num(row.exercisePrice as never)!,
    vesting: { cliffMonths: vesting.cliffMonths, schedule: tranchesOverride ?? vesting.schedule },
    grantLetterRef: row.grantLetterRef,
    status: row.status,
    vested: num(row.vested as never) ?? 0,
    exercised: num(row.exercised as never) ?? 0,
    lapsed: num(row.lapsed as never) ?? 0,
    lapsedOn: row.lapsedOn ? row.lapsedOn.toISOString() : null,
    lapseReason: row.lapseReason,
    exerciseWindowEndsOn: row.exerciseWindowEndsOn ? row.exerciseWindowEndsOn.toISOString() : null,
    promoterCheck: row.promoterCheck as PromoterCheck,
    resolutionRef: row.resolutionRef,
    proposedByPartyId: row.proposedByPartyId,
    approvedByPartyId: row.approvedByPartyId,
  };
}

export async function listGrants() {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'view' });
  const scope = await scopeFor('option_grants', 'view');
  const rows = await prisma.optionGrant.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  const scoped = scope === 'all' ? rows : rows.filter((r) => r.personId === auth.partyId);
  return scoped.map((r) => grantView(r));
}

export async function grant(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'view' });
  const row = await prisma.optionGrant.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Option grant');
  const scope = await scopeFor('option_grants', 'view');
  if (scope !== 'all' && row.personId !== auth.partyId) throw ApiError.notFound('Option grant');
  return grantView(row);
}

// ---------------------------------------------------------------------------
// Vesting
// ---------------------------------------------------------------------------

function nextGrantStatus(count: number, vested: number, exercised: number): 'granted' | 'partly_vested' | 'fully_vested' | 'exercised' {
  if (exercised >= count && exercised > 0) return 'exercised';
  if (vested >= count) return 'fully_vested';
  if (vested > 0) return 'partly_vested';
  return 'granted';
}

/**
 * The daily `esop_vesting` job: marks due tranches vested, once — a tranche
 * already `vested` is never revisited, and one whose employment has since
 * ended is left `scheduled` for the exit subscriber (`handleEmploymentExit`
 * below) to resolve rather than silently vested here.
 */
export async function runVesting(): Promise<number> {
  const auth = currentAuth();
  const due = await prisma.vestingEvent.findMany({
    where: { tenantId: auth.tenantId, status: 'scheduled', on: { lte: new Date() } },
  });

  let vestedCount = 0;
  for (const ve of due) {
    const grantRow = await prisma.optionGrant.findFirst({ where: { id: ve.grantId, tenantId: auth.tenantId } });
    if (!grantRow || !['granted', 'partly_vested'].includes(grantRow.status)) continue;

    const employment = await prisma.employmentRelationship.findFirst({ where: { id: grantRow.employmentId, tenantId: auth.tenantId } });
    if (!employment || !isEmployed(employment.status as EmploymentState)) continue;

    await prisma.vestingEvent.update({ where: { id: ve.id }, data: { status: 'vested', vestedOn: new Date() } });
    const newVested = (num(grantRow.vested) ?? 0) + (num(ve.count) ?? 0);
    const count = num(grantRow.count) ?? 0;
    const updated = await prisma.optionGrant.update({
      where: { id: grantRow.id },
      data: { vested: dec(newVested)!, status: nextGrantStatus(count, newVested, num(grantRow.exercised) ?? 0) },
    });

    await emit({
      name: EVENTS.OPTION_VESTED,
      subject: { entityType: 'option_grant', entityId: grantRow.id, recordCode: grantRow.recordCode },
      newState: { vested: newVested, status: updated.status, tranche: num(ve.count) },
    });
    vestedCount += 1;
  }
  return vestedCount;
}

/** The daily check that lapses a vested-unexercised balance once its post-exit exercise window has passed. */
export async function runExpiredExerciseWindows(): Promise<number> {
  const auth = currentAuth();
  const candidates = await prisma.optionGrant.findMany({
    where: {
      tenantId: auth.tenantId,
      status: { in: ['granted', 'partly_vested', 'fully_vested'] },
      exerciseWindowEndsOn: { not: null, lte: new Date() },
    },
  });

  let lapsedCount = 0;
  for (const g of candidates) {
    const remaining = (num(g.vested) ?? 0) - (num(g.exercised) ?? 0) - 0;
    if (remaining <= 0) continue;

    const updated = await prisma.optionGrant.update({
      where: { id: g.id },
      data: {
        lapsed: dec((num(g.lapsed) ?? 0) + remaining)!,
        status: 'lapsed',
        lapsedOn: new Date(),
        lapseReason: g.lapseReason ?? 'The post-exit exercise window closed with a vested balance unexercised.',
      },
    });
    await emit({
      name: EVENTS.OPTION_LAPSED,
      subject: { entityType: 'option_grant', entityId: g.id, recordCode: g.recordCode },
      newState: { status: 'lapsed', count: remaining, reason: 'exercise_window_expired' },
    });
    void updated;
    lapsedCount += 1;
  }
  return lapsedCount;
}

/**
 * Subscribes to the HRM exit event (`kz.hr.employment.separated`). Unvested
 * tranches lapse immediately; a vested-unexercised balance is left alone but
 * given a deadline (`exerciseWindowEndsOn`) for `runExpiredExerciseWindows`
 * to enforce. Runs inside the same tenant context the transition itself ran
 * in — no `asSystem` needed.
 */
export async function handleEmploymentExit(employmentId: string, exitDate: Date): Promise<void> {
  const auth = currentAuth();
  const grants = await prisma.optionGrant.findMany({
    where: { tenantId: auth.tenantId, employmentId, status: { in: ['proposed', 'granted', 'partly_vested', 'fully_vested'] } },
  });

  for (const g of grants) {
    const count = num(g.count) ?? 0;
    const vested = num(g.vested) ?? 0;
    const exercised = num(g.exercised) ?? 0;
    const alreadyLapsed = num(g.lapsed) ?? 0;
    const unvested = count - vested - alreadyLapsed;
    const vestedUnexercised = vested - exercised;

    if (unvested > 0) {
      await prisma.vestingEvent.updateMany({
        where: { tenantId: auth.tenantId, grantId: g.id, status: 'scheduled' },
        data: { status: 'lapsed' },
      });
    }

    const totalLapsedNow = alreadyLapsed + Math.max(unvested, 0);
    const stillOutstanding = vestedUnexercised > 0;

    let exerciseWindowEndsOn: Date | null = null;
    if (stillOutstanding) {
      const planRow = await prisma.esopPlan.findFirst({ where: { id: g.planId, tenantId: auth.tenantId } });
      const months = planRow?.exerciseWindowMonthsAfterExit ?? 3;
      exerciseWindowEndsOn = new Date(exitDate);
      exerciseWindowEndsOn.setUTCMonth(exerciseWindowEndsOn.getUTCMonth() + months);
    }

    const nextStatus = !stillOutstanding ? 'lapsed' : g.status;

    const updated = await prisma.optionGrant.update({
      where: { id: g.id },
      data: {
        lapsed: dec(totalLapsedNow)!,
        status: nextStatus,
        lapsedOn: !stillOutstanding ? exitDate : g.lapsedOn,
        lapseReason: !stillOutstanding ? 'Employment ended with an unvested balance.' : g.lapseReason,
        exerciseWindowEndsOn,
      },
    });
    void updated;

    if (unvested > 0) {
      await emit({
        name: EVENTS.OPTION_LAPSED,
        subject: { entityType: 'option_grant', entityId: g.id, recordCode: g.recordCode },
        newState: { status: nextStatus, count: unvested, reason: 'employment_ended_unvested' },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------

export interface RequestExerciseInput {
  grantId: string;
  count: number;
  requestedOn?: string;
}

export async function requestExercise(input: RequestExerciseInput) {
  const auth = currentAuth();
  const g = await prisma.optionGrant.findFirst({ where: { id: input.grantId, tenantId: auth.tenantId } });
  if (!g) throw ApiError.notFound('Option grant');

  await assertCan({ resource: 'option_grants', verb: 'view', record: { ownerPartyId: g.personId } });

  const available = (num(g.vested) ?? 0) - (num(g.exercised) ?? 0);
  if (input.count <= 0 || input.count > available) {
    throw ApiError.unprocessable(`Only ${available} vested option(s) on ${g.recordCode} are unexercised; ${input.count} was requested.`);
  }

  const planRow = await prisma.esopPlan.findFirstOrThrow({ where: { id: g.planId } });
  const requestedOn = input.requestedOn ? new Date(input.requestedOn) : new Date();
  const cutoff = new Date(requestedOn.getTime() - ESOP_FMV_VALIDITY_DAYS * 86_400_000);

  const valuation = await prisma.valuation.findFirst({
    where: { tenantId: auth.tenantId, basis: 'merchant_banker', asOf: { gte: cutoff, lte: requestedOn } },
    orderBy: { asOf: 'desc' },
  });

  let fmvPerShare: number | null = null;
  let fmvBasis: 'merchant_banker' | 'none' = 'none';
  let fmvValuationId: string | null = null;
  let perquisite: number | null = null;
  let perquisiteNote: string | null = 'No merchant-banker FMV on record';
  let taxDeferred = false;

  if (valuation) {
    const perShareByClass = valuation.perShareByClass as Record<string, number>;
    fmvPerShare = perShareByClass[planRow.targetShareClassId] ?? Object.values(perShareByClass)[0] ?? null;
    if (fmvPerShare != null) {
      fmvBasis = 'merchant_banker';
      fmvValuationId = valuation.id;
      perquisite = (fmvPerShare - (num(g.exercisePrice) ?? 0)) * input.count;
      perquisiteNote = null;
      const profile = await companyProfile();
      taxDeferred = Boolean(planRow.isDpiitRecognised && profile.iac80CertificateRef);
    }
  }

  const row = await prisma.optionExercise.create({
    data: {
      tenantId: auth.tenantId,
      grantId: g.id,
      requestedOn,
      count: dec(input.count)!,
      exercisePrice: g.exercisePrice,
      fmvPerShare: fmvPerShare == null ? null : dec(fmvPerShare),
      fmvBasis,
      fmvValuationId,
      perquisite: perquisite == null ? null : dec(perquisite),
      perquisiteNote,
      taxDeferred,
      status: 'requested',
      requestedByPartyId: auth.partyId ?? 'system',
    },
  });

  await auditWrite({ action: 'create', subjectType: 'option_exercise', subjectId: row.id, after: row as never });
  await emit({
    name: EVENTS.OPTION_EXERCISE_REQUESTED,
    subject: { entityType: 'option_exercise', entityId: row.id },
    related: [{ relation: 'exercises', entityType: 'option_grant', entityId: g.id }],
    newState: { count: input.count, fmvBasis },
  });

  return exerciseView(row);
}

export async function rejectExercise(id: string, reason: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'approve' });
  const row = await prisma.optionExercise.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Option exercise');
  if (row.status !== 'requested') throw ApiError.conflict(`This exercise request is already ${row.status}.`);

  const updated = await prisma.optionExercise.update({ where: { id }, data: { status: 'rejected' } });
  await auditWrite({ action: 'update', subjectType: 'option_exercise', subjectId: id, before: row as never, after: updated as never });
  await emit({
    name: EVENTS.OPTION_EXERCISE_REQUESTED,
    subject: { entityType: 'option_exercise', entityId: id },
    newState: { status: 'rejected', reason },
  });
  return exerciseView(updated);
}

/**
 * Approves the exercise and allots the shares in the same step, under the
 * same approver: `holderForExercise` finds or creates the `Holder`,
 * `recordExerciseAllotment` writes the (already-approved) `ShareTransaction`,
 * and `makeEffective` (phase 1's own function, unmodified) assigns the
 * distinctive numbers and issues the certificate — the approver needs no
 * grant beyond `option_grants:approve` to do all three, because each of the
 * equity.ts calls gates on `share_ledger:approve`, which this approver
 * already holds by construction (the same role finance holds it under).
 */
export async function approveExercise(id: string) {
  const auth = currentAuth();
  const exercise = await prisma.optionExercise.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!exercise) throw ApiError.notFound('Option exercise');
  if (exercise.status !== 'requested') throw ApiError.conflict(`This exercise request is already ${exercise.status}.`);

  const g = await prisma.optionGrant.findFirstOrThrow({ where: { id: exercise.grantId } });
  if (exercise.requestedByPartyId === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: the requester of an exercise may never approve it.');
  }

  const result = await evaluateApprovalGate(
    'POL-EQT-OPTION-EXERCISE-APPROVAL',
    {
      id: exercise.id,
      type: 'option_exercise',
      resource: 'option_grants',
      label: g.recordCode,
      ownerPartyId: g.personId,
      commercialValue: (num(exercise.exercisePrice) ?? 0) * (num(exercise.count) ?? 0),
      currency: 'INR',
      strategicValue: null,
      termMonths: null,
    },
    'approve',
  );
  if (!result.permitted) {
    throw ApiError.forbidden(result.reason, [{ axis: 'WHO', passed: false, reason: 'self_dealing_or_authority' }]);
  }

  const planRow = await prisma.esopPlan.findFirstOrThrow({ where: { id: g.planId } });
  if (!planRow.targetShareClassId) {
    throw ApiError.unprocessable(`${planRow.recordCode} names no target equity class for its options to convert into; an exercise cannot allot.`);
  }

  const holder = await holderForExercise(g.personId);
  const proposed = await recordExerciseAllotment({
    shareClassId: planRow.targetShareClassId,
    toHolderId: holder.id,
    count: num(exercise.count)!,
    pricePerShare: num(exercise.exercisePrice)!,
    effectiveOn: new Date().toISOString(),
  });
  const effective = await makeEffective(proposed.id);

  const newExercised = (num(g.exercised) ?? 0) + (num(exercise.count) ?? 0);
  const count = num(g.count) ?? 0;
  await prisma.optionGrant.update({
    where: { id: g.id },
    data: { exercised: dec(newExercised)!, status: nextGrantStatus(count, num(g.vested) ?? 0, newExercised) },
  });

  const updated = await prisma.optionExercise.update({
    where: { id },
    data: { status: 'allotted', approvedByPartyId: auth.partyId ?? 'system', allotmentTransactionId: effective.id },
  });

  await auditWrite({ action: 'update', subjectType: 'option_exercise', subjectId: id, before: exercise as never, after: updated as never });
  await emit({
    name: EVENTS.OPTION_EXERCISED,
    subject: { entityType: 'option_exercise', entityId: id },
    related: [
      { relation: 'exercises', entityType: 'option_grant', entityId: g.id },
      { relation: 'allots', entityType: 'share_transaction', entityId: effective.id },
    ],
    newState: { status: 'allotted', count: num(exercise.count) },
  });

  return exerciseView(updated);
}

function exerciseView(row: {
  id: string; grantId: string; requestedOn: Date; count: unknown; exercisePrice: unknown; fmvPerShare: unknown;
  fmvBasis: string; fmvValuationId: string | null; perquisite: unknown; perquisiteNote: string | null;
  taxDeferred: boolean; status: string; allotmentTransactionId: string | null; paidReference: string | null;
}) {
  return {
    id: row.id,
    grantId: row.grantId,
    requestedOn: row.requestedOn.toISOString(),
    count: num(row.count as never)!,
    exercisePrice: num(row.exercisePrice as never)!,
    fmvPerShare: num(row.fmvPerShare as never),
    fmvBasis: row.fmvBasis as 'merchant_banker' | 'none',
    fmvValuationId: row.fmvValuationId,
    perquisite: num(row.perquisite as never),
    perquisiteNote: row.perquisiteNote,
    taxDeferred: row.taxDeferred,
    status: row.status,
    allotmentTransactionId: row.allotmentTransactionId,
    paidReference: row.paidReference,
  };
}

export async function listExercises(grantId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'view' });
  const rows = await prisma.optionExercise.findMany({
    where: { tenantId: auth.tenantId, ...(grantId ? { grantId } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(exerciseView);
}

// ---------------------------------------------------------------------------
// Employee self-view
// ---------------------------------------------------------------------------

export async function myGrants() {
  const auth = currentAuth();
  await assertCan({ resource: 'option_grants', verb: 'view' });
  if (!auth.partyId) throw ApiError.notFound('Option grant');

  const rows = await prisma.optionGrant.findMany({
    where: { tenantId: auth.tenantId, personId: auth.partyId, deletedAt: null },
    orderBy: { grantedOn: 'desc' },
  });

  return Promise.all(
    rows.map(async (r) => {
      const view = grantView(r);
      const planRow = await prisma.esopPlan.findFirst({ where: { id: r.planId } });
      const latestExercise = await prisma.optionExercise.findFirst({
        where: { tenantId: auth.tenantId, grantId: r.id, status: { in: ['requested', 'approved', 'allotted'] } },
        orderBy: { createdAt: 'desc' },
      });
      const hasFmv = Boolean(latestExercise?.fmvBasis === 'merchant_banker');
      const taxDeferred = Boolean(planRow?.isDpiitRecognised && latestExercise?.taxDeferred);
      return { ...view, taxLine: esopTaxLine({ hasFmv, taxDeferred }) };
    }),
  );
}

// ---------------------------------------------------------------------------
// SH-6 register
// ---------------------------------------------------------------------------

export async function sh6Register() {
  const auth = currentAuth();
  await assertCan({ resource: 'esop_plans', verb: 'view' });
  await assertScopeAll('esop_plans');

  const grants = await prisma.optionGrant.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { grantedOn: 'asc' } });
  const personIds = [...new Set(grants.map((g) => g.personId))];
  const people = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } });
  const nameById = new Map(people.map((p) => [p.id, p.fullName]));

  return grants.map((g) => {
    const vesting = g.vesting as never as { cliffMonths: number; schedule: VestingTranche[] };
    return {
      grantId: g.id,
      recordCode: g.recordCode,
      grantee: nameById.get(g.personId) ?? g.personId,
      grantedOn: g.grantedOn.toISOString(),
      optionsGranted: num(g.count)!,
      vestingDates: vesting.schedule.map((t) => t.on),
      exercisePrice: num(g.exercisePrice)!,
      optionsVested: num(g.vested) ?? 0,
      optionsExercised: num(g.exercised) ?? 0,
      sharesAllotted: num(g.exercised) ?? 0,
      optionsLapsed: num(g.lapsed) ?? 0,
      lockIn: 'None recorded',
      variationNotes: g.lapseReason ?? '',
    };
  });
}

export async function sh6Export(): Promise<Buffer> {
  const rows = await sh6Register();
  const header = [
    'Grantee', 'Grant date', 'Options granted', 'Vesting dates', 'Exercise price',
    'Options vested', 'Options exercised', 'Shares allotted', 'Options lapsed', 'Lock-in', 'Variation notes',
  ];
  const data = rows.map((r) => [
    r.grantee,
    r.grantedOn.slice(0, 10),
    r.optionsGranted,
    r.vestingDates.map((d) => d.slice(0, 10)).join('; '),
    r.exercisePrice,
    r.optionsVested,
    r.optionsExercised,
    r.sharesAllotted,
    r.optionsLapsed,
    r.lockIn,
    r.variationNotes,
  ]);
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([header, ...data]);
  sheet['!cols'] = header.map((h) => ({ wch: Math.max(14, Math.min(34, h.length + 6)) }));
  XLSX.utils.book_append_sheet(book, sheet, 'SH-6');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
