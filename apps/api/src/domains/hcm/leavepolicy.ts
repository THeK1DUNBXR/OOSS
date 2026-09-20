/**
 * HCM — leavepolicy: the leave policy engine (docs/hcm/leavepolicy.md).
 *
 * Owns the policy/rule configuration, the monthly accrual job, multi-level
 * approval chains and restricted-holiday elections. It never re-implements
 * what `domains/leave.ts` already owns — the leave request state machine, the
 * ledger, `accrueEntitlement` — it calls into that module's exported helpers.
 *
 * Wiring note (see docs/hcm/leavepolicy.md "Wanted from the scaffold"):
 * there is no `leave_request.before_create` hook point in `platform/hooks.ts`,
 * so a request cannot be blocked at the moment it is written. Two real paths
 * exist instead: `validateLeaveRequest` is exposed as `POST /validate` for a
 * form to check before submitting, and this module subscribes to
 * `LEAVE_REQUEST_CREATED` to raise an exception on a request that already
 * violates its policy and to open its approval chain — both real, both after
 * the write rather than blocking it.
 */

import {
  EVENTS,
  RESTRICTED_HOLIDAY_ANNUAL_LIMIT,
  creditableWithinCap,
  parseAccrualPeriod,
  proratedAccrual,
  validateLeaveRequestAgainstPolicy,
  type AccrualFrequency,
  type PolicyRuleFacts,
  type EventEnvelope,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { emit, subscribe } from '../../platform/eventBus.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan, scopeFor } from '../../platform/permissions.js';
import { assertEmploymentVisible } from '../../platform/recordScope.js';
import { raiseException } from '../../platform/exceptions.js';
import { accrueEntitlement } from '../leave.js';
import { leaveWorkingDayCount } from '../compliance/labour.js';
import type { JobResult } from '../../jobs/scheduler.js';

const ACCRUAL_FREQUENCIES = ['monthly', 'quarterly', 'yearly', 'none'] as const;

function assertFrequency(v: string): AccrualFrequency {
  if (!(ACCRUAL_FREQUENCIES as readonly string[]).includes(v)) {
    throw ApiError.badRequest(`"${v}" is not an accrual frequency. Expected ${ACCRUAL_FREQUENCIES.join(', ')}.`);
  }
  return v as AccrualFrequency;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function listLeavePolicies(filter: { status?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'view' });
  return prisma.leavePolicy.findMany({
    where: { tenantId: auth.tenantId, ...(filter.status ? { status: filter.status } : {}) },
    include: { rules: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getLeavePolicy(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'view' });
  const policy = await prisma.leavePolicy.findFirst({ where: { id, tenantId: auth.tenantId }, include: { rules: true } });
  if (!policy) throw ApiError.notFound('Leave policy');
  return policy;
}

export interface CreateLeavePolicyInput {
  name: string;
  description?: string | null;
  engagementTypes?: string[];
  orgUnitIds?: string[];
  gradeCodes?: string[];
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}

export async function createLeavePolicy(input: CreateLeavePolicyInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'create' });

  if (!input.name.trim()) throw ApiError.badRequest('A leave policy needs a name.');
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw ApiError.unprocessable('A policy cannot end before it starts.');
  }

  const policy = await prisma.leavePolicy.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      description: input.description ?? null,
      engagementTypes: input.engagementTypes ?? [],
      orgUnitIds: input.orgUnitIds ?? [],
      gradeCodes: input.gradeCodes ?? [],
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
    },
  });

  await emit({
    name: EVENTS.LEAVE_POLICY_CREATED,
    subject: { entityType: 'leave_policy', entityId: policy.id },
    newState: { name: policy.name, effectiveFrom: input.effectiveFrom },
    impact: { domains: ['hr'] },
  });

  return policy;
}

export async function updateLeavePolicy(
  id: string,
  patch: Partial<Omit<CreateLeavePolicyInput, 'effectiveFrom'>> & { effectiveFrom?: Date; status?: string },
) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'edit' });
  const existing = await prisma.leavePolicy.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!existing) throw ApiError.notFound('Leave policy');

  if (patch.status && !['active', 'retired'].includes(patch.status)) {
    throw ApiError.badRequest(`"${patch.status}" is not a policy status. Expected active or retired.`);
  }

  const policy = await prisma.leavePolicy.update({
    where: { id },
    data: {
      name: patch.name ?? undefined,
      description: patch.description === undefined ? undefined : patch.description,
      engagementTypes: patch.engagementTypes ?? undefined,
      orgUnitIds: patch.orgUnitIds ?? undefined,
      gradeCodes: patch.gradeCodes ?? undefined,
      effectiveFrom: patch.effectiveFrom ?? undefined,
      effectiveTo: patch.effectiveTo === undefined ? undefined : patch.effectiveTo,
      status: patch.status ?? undefined,
    },
  });

  await emit({
    name: EVENTS.LEAVE_POLICY_UPDATED,
    subject: { entityType: 'leave_policy', entityId: policy.id },
    newState: { name: policy.name, status: policy.status },
    impact: { domains: ['hr'] },
  });

  return policy;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface UpsertLeavePolicyRuleInput {
  leaveTypeId: string;
  accrualFrequency?: string;
  accrualDays?: number;
  prorateOnJoin?: boolean;
  maxBalanceDays?: number | null;
  carryForwardCapDays?: number | null;
  negativeAllowed?: boolean;
  minNoticeDays?: number;
  maxConsecutiveDays?: number | null;
  sandwichRule?: boolean;
  requiresDocumentAfterDays?: number | null;
  applicableGender?: string | null;
}

export async function listPolicyRules(leavePolicyId: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'view' });
  const policy = await prisma.leavePolicy.findFirst({ where: { id: leavePolicyId, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Leave policy');
  return prisma.leavePolicyRule.findMany({ where: { tenantId: auth.tenantId, leavePolicyId }, orderBy: { createdAt: 'asc' } });
}

export async function createPolicyRule(leavePolicyId: string, input: UpsertLeavePolicyRuleInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'edit' });

  const policy = await prisma.leavePolicy.findFirst({ where: { id: leavePolicyId, tenantId: auth.tenantId } });
  if (!policy) throw ApiError.notFound('Leave policy');

  const leaveType = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, tenantId: auth.tenantId } });
  if (!leaveType) throw ApiError.notFound('Leave type');

  const existing = await prisma.leavePolicyRule.findUnique({
    where: { leavePolicyId_leaveTypeId: { leavePolicyId, leaveTypeId: input.leaveTypeId } },
  });
  if (existing) {
    throw ApiError.conflict(`${policy.name} already has a rule for ${leaveType.name}. Edit that rule instead of adding another.`, {
      leavePolicyRuleId: existing.id,
    });
  }

  const frequency = assertFrequency(input.accrualFrequency ?? 'monthly');
  if (input.applicableGender && !['male', 'female', 'any'].includes(input.applicableGender)) {
    throw ApiError.badRequest(`"${input.applicableGender}" is not a gender applicability. Expected male, female or any.`);
  }

  const rule = await prisma.leavePolicyRule.create({
    data: {
      tenantId: auth.tenantId,
      leavePolicyId,
      leaveTypeId: input.leaveTypeId,
      accrualFrequency: frequency,
      accrualDays: input.accrualDays ?? 0,
      prorateOnJoin: input.prorateOnJoin ?? true,
      maxBalanceDays: input.maxBalanceDays ?? null,
      carryForwardCapDays: input.carryForwardCapDays ?? null,
      negativeAllowed: input.negativeAllowed ?? false,
      minNoticeDays: input.minNoticeDays ?? 0,
      maxConsecutiveDays: input.maxConsecutiveDays ?? null,
      sandwichRule: input.sandwichRule ?? false,
      requiresDocumentAfterDays: input.requiresDocumentAfterDays ?? null,
      applicableGender: input.applicableGender ?? null,
    },
  });

  await emit({
    name: EVENTS.LEAVE_POLICY_UPDATED,
    subject: { entityType: 'leave_policy', entityId: leavePolicyId },
    newState: { ruleAdded: leaveType.code },
    impact: { domains: ['hr'] },
  });

  return rule;
}

export async function updatePolicyRule(id: string, patch: Partial<UpsertLeavePolicyRuleInput>) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'edit' });
  const rule = await prisma.leavePolicyRule.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!rule) throw ApiError.notFound('Leave policy rule');

  if (patch.applicableGender && !['male', 'female', 'any'].includes(patch.applicableGender)) {
    throw ApiError.badRequest(`"${patch.applicableGender}" is not a gender applicability. Expected male, female or any.`);
  }

  const updated = await prisma.leavePolicyRule.update({
    where: { id },
    data: {
      accrualFrequency: patch.accrualFrequency ? assertFrequency(patch.accrualFrequency) : undefined,
      accrualDays: patch.accrualDays ?? undefined,
      prorateOnJoin: patch.prorateOnJoin ?? undefined,
      maxBalanceDays: patch.maxBalanceDays === undefined ? undefined : patch.maxBalanceDays,
      carryForwardCapDays: patch.carryForwardCapDays === undefined ? undefined : patch.carryForwardCapDays,
      negativeAllowed: patch.negativeAllowed ?? undefined,
      minNoticeDays: patch.minNoticeDays ?? undefined,
      maxConsecutiveDays: patch.maxConsecutiveDays === undefined ? undefined : patch.maxConsecutiveDays,
      sandwichRule: patch.sandwichRule ?? undefined,
      requiresDocumentAfterDays: patch.requiresDocumentAfterDays === undefined ? undefined : patch.requiresDocumentAfterDays,
      applicableGender: patch.applicableGender === undefined ? undefined : patch.applicableGender,
    },
  });

  await emit({
    name: EVENTS.LEAVE_POLICY_UPDATED,
    subject: { entityType: 'leave_policy', entityId: rule.leavePolicyId },
    newState: { ruleUpdated: id },
    impact: { domains: ['hr'] },
  });

  return updated;
}

export async function deletePolicyRule(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_policies', verb: 'delete' });
  const rule = await prisma.leavePolicyRule.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!rule) throw ApiError.notFound('Leave policy rule');
  await prisma.leavePolicyRule.delete({ where: { id } });
  await emit({
    name: EVENTS.LEAVE_POLICY_UPDATED,
    subject: { entityType: 'leave_policy', entityId: rule.leavePolicyId },
    newState: { ruleRemoved: id },
    impact: { domains: ['hr'] },
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Applicability resolution
// ---------------------------------------------------------------------------

/** The org unit an employment currently sits in, via its latest effective assignment — best-effort, null when none is on record. */
async function currentOrgUnitId(employmentRelationshipId: string): Promise<string | null> {
  const assignment = await prisma.assignment.findFirst({
    where: { employmentRelationshipId, rowStatus: 'Effective' },
    orderBy: { effectiveFrom: 'desc' },
    select: { position: { select: { orgUnitId: true } } },
  });
  return assignment?.position.orgUnitId ?? null;
}

/**
 * The policy (and its rule for `leaveTypeId`) that applies to one employment,
 * as of `at`. Later-effective, more specific policies (an applicability list
 * given, rather than left as "everybody") win over the generic default.
 * Returns null rather than throwing when nothing is configured — "no policy
 * governs this" is a fact this system does not enforce silence about, and the
 * caller decides what that means for it.
 */
export async function resolveApplicablePolicy(
  employmentRelationshipId: string,
  leaveTypeId: string,
  at: Date = new Date(),
): Promise<{ policy: { id: string; name: string }; rule: PolicyRuleFacts & { id: string } } | null> {
  await assertCan({ resource: 'leave_policies', verb: 'view' });
  const auth = currentAuth();
  const employment = await prisma.employmentRelationship.findFirst({
    where: { id: employmentRelationshipId, tenantId: auth.tenantId },
  });
  if (!employment) throw ApiError.notFound('Employment relationship');

  const candidates = await prisma.leavePolicy.findMany({
    where: {
      tenantId: auth.tenantId,
      status: 'active',
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      rules: { some: { leaveTypeId } },
    },
    include: { rules: { where: { leaveTypeId } } },
    orderBy: { effectiveFrom: 'desc' },
  });

  const orgUnitId = await currentOrgUnitId(employmentRelationshipId);

  const scored = candidates
    .filter((p) => p.engagementTypes.length === 0 || p.engagementTypes.includes(employment.engagementType))
    .filter((p) => p.orgUnitIds.length === 0 || (orgUnitId !== null && p.orgUnitIds.includes(orgUnitId)))
    .map((p) => ({
      policy: p,
      specificity: p.engagementTypes.length + p.orgUnitIds.length + p.gradeCodes.length,
    }))
    .sort((a, b) => b.specificity - a.specificity || b.policy.effectiveFrom.getTime() - a.policy.effectiveFrom.getTime());

  const best = scored[0]?.policy;
  const rule = best?.rules[0];
  if (!best || !rule) return null;

  return {
    policy: { id: best.id, name: best.name },
    rule: {
      id: rule.id,
      accrualFrequency: rule.accrualFrequency as AccrualFrequency,
      accrualDays: num(rule.accrualDays) ?? 0,
      prorateOnJoin: rule.prorateOnJoin,
      maxBalanceDays: num(rule.maxBalanceDays),
      carryForwardCapDays: num(rule.carryForwardCapDays),
      negativeAllowed: rule.negativeAllowed,
      minNoticeDays: rule.minNoticeDays,
      maxConsecutiveDays: rule.maxConsecutiveDays,
      sandwichRule: rule.sandwichRule,
      requiresDocumentAfterDays: rule.requiresDocumentAfterDays,
      applicableGender: rule.applicableGender,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateLeaveRequestInput {
  employmentRelationshipId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  submittedAt?: Date;
  hasDocument?: boolean;
  gender?: string | null;
}

/**
 * Checks a would-be leave request against the policy that applies to it —
 * the pre-flight check `POST /validate` exposes for a form to call before
 * `POST /hr/leave-requests` (see this file's module doc for why it cannot be
 * a hard server-side gate on that write today).
 */
export async function validateLeaveRequest(input: ValidateLeaveRequestInput) {
  await assertEmploymentVisible('leave', input.employmentRelationshipId, 'view');

  if (input.endDate < input.startDate) throw ApiError.unprocessable('A leave request cannot end before it starts.');

  const resolved = await resolveApplicablePolicy(input.employmentRelationshipId, input.leaveTypeId, input.startDate);
  const workingDays = await leaveWorkingDayCount(input.startDate, input.endDate);

  if (!resolved) {
    return { ok: true, policy: null, rule: null, violations: [], effectiveDays: workingDays, documentRequired: false };
  }

  const balance = await prisma.leaveBalance.findUnique({
    where: {
      employmentRelationshipId_leaveTypeId: {
        employmentRelationshipId: input.employmentRelationshipId,
        leaveTypeId: input.leaveTypeId,
      },
    },
  });
  const availableDays = (num(balance?.balanceDays) ?? 0) - (num(balance?.heldDays) ?? 0);

  const result = validateLeaveRequestAgainstPolicy(resolved.rule, {
    startDate: input.startDate,
    endDate: input.endDate,
    workingDays,
    submittedAt: input.submittedAt ?? new Date(),
    availableDays,
    gender: input.gender ?? null,
    hasDocument: input.hasDocument,
  });

  return { ...result, policy: resolved.policy, rule: { id: resolved.rule.id } };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/** Employments an applicability-scoped policy reaches: active, matching engagement type and (if given) org unit. */
async function employmentsForPolicy(tenantId: string, policy: { engagementTypes: string[]; orgUnitIds: string[] }) {
  const base = await prisma.employmentRelationship.findMany({
    where: {
      tenantId,
      deletedAt: null,
      status: { in: ['Active', 'OnLeave'] },
      ...(policy.engagementTypes.length ? { engagementType: { in: policy.engagementTypes } } : {}),
    },
  });
  if (policy.orgUnitIds.length === 0) return base;

  const inOrgUnits = await prisma.assignment.findMany({
    where: { tenantId, rowStatus: 'Effective', position: { orgUnitId: { in: policy.orgUnitIds } } },
    select: { employmentRelationshipId: true },
  });
  const allowed = new Set(inOrgUnits.map((a) => a.employmentRelationshipId));
  return base.filter((e) => allowed.has(e.id));
}

/**
 * Runs (or returns the already-run result of) one rule's accrual for one
 * period. Idempotent on `(leavePolicyRuleId, period)` via `AccrualRun`'s
 * unique constraint — a second call for a period already closed is a no-op
 * that returns the original run, never a double credit.
 */
export async function runAccrualForRule(leavePolicyRuleId: string, period: string): Promise<{ run: unknown; idempotent: boolean }> {
  const auth = currentAuth();
  if (auth.principalType !== 'system') await assertCan({ resource: 'leave_accruals', verb: 'create' });

  const rule = await prisma.leavePolicyRule.findFirst({
    where: { id: leavePolicyRuleId, tenantId: auth.tenantId },
    include: { leavePolicy: true },
  });
  if (!rule) throw ApiError.notFound('Leave policy rule');
  if (rule.accrualFrequency === 'none') {
    throw ApiError.unprocessable(`${rule.leavePolicy.name}'s rule for this leave type does not accrue.`);
  }

  const existing = await prisma.accrualRun.findUnique({
    where: { tenantId_leavePolicyRuleId_period: { tenantId: auth.tenantId, leavePolicyRuleId, period } },
  });
  if (existing) return { run: existing, idempotent: true };

  const { start, end } = parseAccrualPeriod(rule.accrualFrequency as AccrualFrequency, period);
  const employments = await employmentsForPolicy(auth.tenantId, rule.leavePolicy);
  const accrualDays = num(rule.accrualDays) ?? 0;
  const maxBalanceDays = num(rule.maxBalanceDays);

  let totalAccrued = 0;
  let processed = 0;

  for (const employment of employments) {
    const credit = rule.prorateOnJoin
      ? proratedAccrual(accrualDays, start, end, employment.hireEffectiveDate, employment.separationDate)
      : accrualDays;
    if (credit <= 0) continue;

    const balance = await prisma.leaveBalance.findUnique({
      where: { employmentRelationshipId_leaveTypeId: { employmentRelationshipId: employment.id, leaveTypeId: rule.leaveTypeId } },
    });
    const currentBalance = num(balance?.balanceDays) ?? 0;
    const creditable = creditableWithinCap(currentBalance, credit, maxBalanceDays);
    if (creditable <= 0) {
      processed += 1;
      continue;
    }

    await accrueEntitlement({
      employmentRelationshipId: employment.id,
      leaveTypeId: rule.leaveTypeId,
      days: creditable,
      note: `Accrual run ${period} — ${rule.leavePolicy.name}`,
    });
    totalAccrued += creditable;
    processed += 1;
  }

  const run = await prisma.accrualRun.create({
    data: {
      tenantId: auth.tenantId,
      leavePolicyRuleId,
      leaveTypeId: rule.leaveTypeId,
      period,
      status: 'completed',
      employeesProcessed: processed,
      totalDaysAccrued: totalAccrued,
      createdById: auth.partyId,
    },
  });

  await emit({
    name: EVENTS.LEAVE_ACCRUAL_RUN_COMPLETED,
    subject: { entityType: 'accrual_run', entityId: run.id },
    newState: { leavePolicyRuleId, period, employeesProcessed: processed, totalDaysAccrued: totalAccrued },
    impact: { domains: ['hr'] },
  });

  return { run, idempotent: false };
}

/** Runs every accruing rule of every active policy for `period` (monthly key `YYYY-MM`) — what the scheduled job calls. */
export async function runMonthlyAccrual(period: string = new Date().toISOString().slice(0, 7)): Promise<JobResult> {
  const auth = currentAuth();
  const rules = await prisma.leavePolicyRule.findMany({
    where: { tenantId: auth.tenantId, accrualFrequency: 'monthly', leavePolicy: { status: 'active' } },
  });

  const errors: string[] = [];
  let processed = 0;
  for (const rule of rules) {
    try {
      const { idempotent } = await runAccrualForRule(rule.id, period);
      if (!idempotent) processed += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed, notified: 0, skippedIdempotent: rules.length - processed - errors.length, errors };
}

/**
 * An `AccrualRun` row summarises every employment a rule touched in one
 * period — it has no owning employment of its own to narrow by. An
 * own-scope grant (what `employee` holds on `leave_accruals`) cannot
 * legitimately see this, since "own" here would mean nothing narrower than
 * "everybody's" — so this is admin-only rather than silently wide open to
 * anyone holding `view` at any scope (see docs/hcm/leavepolicy.md's scope-axis
 * fix note).
 */
export async function listAccrualRuns(filter: { leavePolicyRuleId?: string; period?: string } = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_accruals', verb: 'view' });
  if ((await scopeFor('leave_accruals', 'view')) !== 'all') {
    throw ApiError.forbidden(
      'Accrual runs summarise every employment a rule touched — there is no "your own" view of that.',
      [{ axis: 'WHERE', passed: false, reason: 'own_scope_insufficient_for_aggregate_record' }],
    );
  }
  return prisma.accrualRun.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(filter.leavePolicyRuleId ? { leavePolicyRuleId: filter.leavePolicyRuleId } : {}),
      ...(filter.period ? { period: filter.period } : {}),
    },
    orderBy: { runAt: 'desc' },
    take: 200,
  });
}

// ---------------------------------------------------------------------------
// Approval chains
// ---------------------------------------------------------------------------

export type ChainLevelKind = 'manager' | 'hr' | 'custom_grant';
export interface ChainLevel {
  level: number;
  kind: ChainLevelKind;
  approverPartyId?: string | null;
}

function validateLevels(levels: unknown): ChainLevel[] {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw ApiError.badRequest('An approval chain needs at least one level.');
  }
  return levels.map((raw, idx) => {
    const l = raw as ChainLevel;
    if (typeof l.level !== 'number') throw ApiError.badRequest(`Level ${idx + 1} needs a numeric \`level\`.`);
    if (!['manager', 'hr', 'custom_grant'].includes(l.kind)) {
      throw ApiError.badRequest(`Level ${idx + 1}'s kind must be manager, hr or custom_grant.`);
    }
    if (l.kind === 'custom_grant' && !l.approverPartyId) {
      throw ApiError.badRequest(`Level ${idx + 1} is custom_grant and needs an \`approverPartyId\`.`);
    }
    return { level: l.level, kind: l.kind, approverPartyId: l.approverPartyId ?? null };
  });
}

export async function listApprovalChains() {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_approval_chains', verb: 'view' });
  return prisma.leaveApprovalChain.findMany({ where: { tenantId: auth.tenantId }, orderBy: { createdAt: 'desc' } });
}

export async function createApprovalChain(input: { name: string; leavePolicyId?: string | null; levels: unknown; isDefault?: boolean }) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_approval_chains', verb: 'create' });
  const levels = validateLevels(input.levels);

  if (input.leavePolicyId) {
    const policy = await prisma.leavePolicy.findFirst({ where: { id: input.leavePolicyId, tenantId: auth.tenantId } });
    if (!policy) throw ApiError.notFound('Leave policy');
  }

  const chain = await prisma.leaveApprovalChain.create({
    data: {
      tenantId: auth.tenantId,
      name: input.name,
      leavePolicyId: input.leavePolicyId ?? null,
      levels: levels as never,
      isDefault: input.isDefault ?? false,
    },
  });

  await emit({
    name: EVENTS.LEAVE_APPROVAL_CHAIN_UPDATED,
    subject: { entityType: 'leave_approval_chain', entityId: chain.id },
    newState: { name: chain.name, levels: levels.length },
    impact: { domains: ['hr'] },
  });

  return chain;
}

export async function updateApprovalChain(id: string, patch: { name?: string; levels?: unknown; isDefault?: boolean }) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_approval_chains', verb: 'edit' });
  const chain = await prisma.leaveApprovalChain.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!chain) throw ApiError.notFound('Leave approval chain');

  const levels = patch.levels !== undefined ? validateLevels(patch.levels) : undefined;
  const updated = await prisma.leaveApprovalChain.update({
    where: { id },
    data: {
      name: patch.name ?? undefined,
      levels: levels ? (levels as never) : undefined,
      isDefault: patch.isDefault ?? undefined,
    },
  });

  await emit({
    name: EVENTS.LEAVE_APPROVAL_CHAIN_UPDATED,
    subject: { entityType: 'leave_approval_chain', entityId: id },
    newState: { name: updated.name },
    impact: { domains: ['hr'] },
  });

  return updated;
}

export async function deleteApprovalChain(id: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave_approval_chains', verb: 'delete' });
  const chain = await prisma.leaveApprovalChain.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!chain) throw ApiError.notFound('Leave approval chain');
  await prisma.leaveApprovalChain.delete({ where: { id } });
  return { deleted: true };
}

/** The HR ops manager, resolved by role rather than remembered — the same pattern compliance/labour.ts uses for its exception owner. */
async function hrOpsOwnerId(tenantId: string): Promise<string | null> {
  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { tenantId, roleSlug: 'hr_ops_manager', status: 'active' },
    select: { partyId: true },
  });
  return affiliation?.partyId ?? null;
}

/** The requester's manager, via the current effective assignment's `managerPositionId` and whoever presently holds that seat. */
async function resolveManagerPartyId(tenantId: string, employmentRelationshipId: string): Promise<string | null> {
  const assignment = await prisma.assignment.findFirst({
    where: { tenantId, employmentRelationshipId, rowStatus: 'Effective' },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!assignment?.managerPositionId) return null;

  const managerAssignment = await prisma.assignment.findFirst({
    where: { tenantId, positionId: assignment.managerPositionId, rowStatus: 'Effective' },
    include: { employmentRelationship: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  return managerAssignment?.employmentRelationship.personId ?? null;
}

async function resolveDefaultChain(tenantId: string, leavePolicyId: string | null) {
  return (
    (leavePolicyId &&
      (await prisma.leaveApprovalChain.findFirst({ where: { tenantId, leavePolicyId } }))) ??
    prisma.leaveApprovalChain.findFirst({ where: { tenantId, isDefault: true } })
  );
}

/**
 * Opens the approval chain for a leave request: one `LeaveRequestApproval`
 * row per level, each with its approver resolved now (manager and hr are
 * resolved deterministically from org structure; `custom_grant` carries the
 * partyId the chain was configured with). Idempotent — a request that
 * already has approval rows is returned as-is.
 */
export async function initiateApprovalChain(leaveRequestId: string, chainId?: string) {
  const auth = currentAuth();
  const request = await prisma.leaveRequest.findFirst({
    where: { id: leaveRequestId, tenantId: auth.tenantId },
    include: { leaveType: true },
  });
  if (!request) throw ApiError.notFound('Leave request');
  await assertEmploymentVisible('leave', request.employmentRelationshipId, 'edit');

  const already = await prisma.leaveRequestApproval.findMany({ where: { tenantId: auth.tenantId, leaveRequestId } });
  if (already.length > 0) return already;

  const resolved = await resolveApplicablePolicy(request.employmentRelationshipId, request.leaveTypeId, request.startDate).catch(
    () => null,
  );
  const chain = chainId
    ? await prisma.leaveApprovalChain.findFirst({ where: { id: chainId, tenantId: auth.tenantId } })
    : await resolveDefaultChain(auth.tenantId, resolved?.policy.id ?? null);
  if (!chain) return [];

  const levels = chain.levels as unknown as ChainLevel[];
  const rows: Awaited<ReturnType<typeof prisma.leaveRequestApproval.create>>[] = [];
  for (const level of levels) {
    const approverPartyId =
      level.kind === 'manager'
        ? await resolveManagerPartyId(auth.tenantId, request.employmentRelationshipId)
        : level.kind === 'hr'
          ? await hrOpsOwnerId(auth.tenantId)
          : (level.approverPartyId ?? null);

    rows.push(
      await prisma.leaveRequestApproval.create({
        data: {
          tenantId: auth.tenantId,
          leaveRequestId,
          chainId: chain.id,
          level: level.level,
          kind: level.kind,
          approverPartyId,
          decision: 'pending',
        },
      }),
    );
  }
  return rows;
}

export async function listApprovalsForRequest(leaveRequestId: string) {
  const auth = currentAuth();
  const request = await prisma.leaveRequest.findFirst({ where: { id: leaveRequestId, tenantId: auth.tenantId } });
  if (!request) throw ApiError.notFound('Leave request');
  await assertEmploymentVisible('leave', request.employmentRelationshipId, 'view');
  return prisma.leaveRequestApproval.findMany({ where: { tenantId: auth.tenantId, leaveRequestId }, orderBy: { level: 'asc' } });
}

/** Every pending level resolved to the caller — no broad grant required, since it is scoped to their own partyId already (see `decideApprovalLevel`'s identity-based authority). */
export async function listMyInbox() {
  const auth = currentAuth();
  if (!auth.partyId) return [];
  return prisma.leaveRequestApproval.findMany({
    where: { tenantId: auth.tenantId, approverPartyId: auth.partyId, decision: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Decides one level. The Self-Dealing Bar: the decider may never be the
 * person the leave belongs to, and must be the level's resolved approver
 * unless they hold `leave:approve` at `all` scope acting on HR's behalf (the
 * same shape `leave.ts`'s own APPROVE/REJECT transition already grants).
 */
export async function decideApprovalLevel(id: string, decision: 'approved' | 'rejected', note?: string) {
  const auth = currentAuth();

  const approval = await prisma.leaveRequestApproval.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!approval) throw ApiError.notFound('Approval');
  if (approval.decision !== 'pending') {
    throw ApiError.unprocessable(`This level is already ${approval.decision}.`);
  }

  const request = await prisma.leaveRequest.findFirst({
    where: { id: approval.leaveRequestId, tenantId: auth.tenantId },
    include: { employmentRelationship: true },
  });
  if (!request) throw ApiError.notFound('Leave request');

  if (auth.partyId && auth.partyId === request.employmentRelationship.personId) {
    throw ApiError.forbidden('Nobody may approve their own leave — the Self-Dealing Bar applies here as everywhere else.', [
      { axis: 'WHO', passed: false, reason: 'self_dealing' },
    ]);
  }

  // The level's own resolved approver may decide it on the strength of that
  // resolution alone — a delegated, per-record authority the coarse
  // role/grant matrix does not otherwise express (an ordinary manager holds
  // no blanket `leave:approve`). Anybody else needs the broad HR/finance
  // grant instead, as an override of a level nobody was resolved for.
  const isResolvedApprover = Boolean(approval.approverPartyId) && approval.approverPartyId === auth.partyId;
  if (!isResolvedApprover) {
    await assertCan({ resource: 'leave', verb: 'approve' });
  }

  if (!['approved', 'rejected'].includes(decision)) {
    throw ApiError.badRequest(`"${decision}" is not a decision. Expected approved or rejected.`);
  }

  const updated = await prisma.leaveRequestApproval.update({
    where: { id },
    data: { decision, decidedAt: new Date(), note: note ?? null, approverPartyId: approval.approverPartyId ?? auth.partyId },
  });

  await emit({
    name: EVENTS.LEAVE_APPROVAL_CHAIN_UPDATED,
    subject: { entityType: 'leave_request', entityId: request.id, recordCode: request.recordCode },
    newState: { level: approval.level, decision },
    owner: { partyId: request.employmentRelationship.personId },
    impact: { domains: ['hr'] },
  });

  if (decision === 'rejected') {
    // A rejected level does not chase further levels — the chain stops here,
    // and the substantive REJECT still runs through leave.ts's own machine.
    await prisma.leaveRequestApproval.updateMany({
      where: { tenantId: auth.tenantId, leaveRequestId: request.id, decision: 'pending' },
      data: { decision: 'skipped', decidedAt: new Date(), note: `Skipped: level ${approval.level} rejected.` },
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Restricted holiday elections
// ---------------------------------------------------------------------------

export async function listRestrictedHolidayElections(employmentRelationshipId: string) {
  const auth = currentAuth();
  await assertEmploymentVisible('leave', employmentRelationshipId, 'view');
  return prisma.restrictedHolidayElection.findMany({
    where: { tenantId: auth.tenantId, employmentRelationshipId },
    orderBy: { electedAt: 'desc' },
  });
}

export async function electRestrictedHoliday(input: { employmentRelationshipId: string; holidayId: string; fy: string }) {
  const auth = currentAuth();
  await assertEmploymentVisible('leave', input.employmentRelationshipId, 'edit');

  const holiday = await prisma.holiday.findFirst({ where: { id: input.holidayId, tenantId: auth.tenantId } });
  if (!holiday) throw ApiError.notFound('Holiday');
  if (holiday.kind !== 'restricted') throw ApiError.unprocessable(`${holiday.name} is a ${holiday.kind} holiday, not restricted.`);

  const already = await prisma.restrictedHolidayElection.count({
    where: { tenantId: auth.tenantId, employmentRelationshipId: input.employmentRelationshipId, fy: input.fy },
  });
  if (already >= RESTRICTED_HOLIDAY_ANNUAL_LIMIT) {
    throw ApiError.unprocessable(`Only ${RESTRICTED_HOLIDAY_ANNUAL_LIMIT} restricted holidays may be elected per year; ${input.fy} already has ${already}.`);
  }

  return prisma.restrictedHolidayElection.create({
    data: {
      tenantId: auth.tenantId,
      employmentRelationshipId: input.employmentRelationshipId,
      holidayId: input.holidayId,
      fy: input.fy,
      createdById: auth.partyId,
    },
  });
}

export async function withdrawRestrictedHolidayElection(id: string) {
  const auth = currentAuth();
  const row = await prisma.restrictedHolidayElection.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!row) throw ApiError.notFound('Restricted holiday election');
  await assertEmploymentVisible('leave', row.employmentRelationshipId, 'edit');
  await prisma.restrictedHolidayElection.delete({ where: { id } });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Team calendar (derived — no model of its own)
// ---------------------------------------------------------------------------

export interface TeamCalendarEntry {
  employmentRelationshipId: string;
  fullName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  status: string;
}

/** The month's approved/in-progress leave for one org unit's team, plus the holidays that fall in it — what the calendar grid renders. */
export async function teamCalendar(month: string, orgUnitId?: string) {
  const auth = currentAuth();
  await assertCan({ resource: 'leave', verb: 'view' });
  // `employee` holds `leave:view` at `own` scope — the coarse check above
  // passes for them too, but this reads every employment's leave across an
  // org unit (or the whole tenant), not the caller's own. Passing no record
  // to `assertCan` above means the WHERE axis was never actually asked, so
  // it is asked explicitly here: a "team" view is inherently about other
  // people's records, and `own` scope cannot answer for that (see
  // docs/hcm/leavepolicy.md's scope-axis fix note).
  if ((await scopeFor('leave', 'view')) !== 'all') {
    throw ApiError.forbidden('The team calendar shows other employments’ leave — an own-scope view cannot answer for that.', [
      { axis: 'WHERE', passed: false, reason: 'own_scope_insufficient_for_team_view' },
    ]);
  }

  const [y, m] = month.split('-').map(Number);
  if (!y || !m) throw ApiError.badRequest(`"${month}" is not a YYYY-MM month.`);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));

  let employmentIds: string[] | null = null;
  if (orgUnitId) {
    const assignments = await prisma.assignment.findMany({
      where: { tenantId: auth.tenantId, rowStatus: 'Effective', position: { orgUnitId } },
      select: { employmentRelationshipId: true },
    });
    employmentIds = assignments.map((a) => a.employmentRelationshipId);
  }

  const requests = await prisma.leaveRequest.findMany({
    where: {
      tenantId: auth.tenantId,
      deletedAt: null,
      status: { in: ['Approved', 'InProgress', 'Extended', 'Completed'] },
      startDate: { lt: to },
      endDate: { gte: from },
      ...(employmentIds ? { employmentRelationshipId: { in: employmentIds } } : {}),
    },
    include: { leaveType: true, employmentRelationship: { include: { person: { select: { fullName: true } } } } },
    orderBy: { startDate: 'asc' },
  });

  const holidays = await prisma.holiday.findMany({ where: { tenantId: auth.tenantId, date: { gte: from, lt: to } } });

  const entries: TeamCalendarEntry[] = requests.map((r) => ({
    employmentRelationshipId: r.employmentRelationshipId,
    fullName: r.employmentRelationship.person.fullName,
    leaveTypeName: r.leaveType.name,
    startDate: r.startDate.toISOString().slice(0, 10),
    endDate: r.endDate.toISOString().slice(0, 10),
    status: r.status,
  }));

  return {
    month,
    entries,
    holidays: holidays.map((h) => ({ date: h.date.toISOString().slice(0, 10), name: h.name, kind: h.kind })),
  };
}

// ---------------------------------------------------------------------------
// Wiring: react to a leave request being created without editing leave.ts.
// ---------------------------------------------------------------------------

subscribe(EVENTS.LEAVE_REQUEST_CREATED, 'hcm.leavepolicy.on_created', async (event: EventEnvelope) => {
  const leaveRequestId = event.subject.entityId;
  const tenantId = event.tenantId;
  if (!tenantId) return;

  try {
    const request = await unscopedPrisma.leaveRequest.findFirst({
      where: { id: leaveRequestId, tenantId },
      include: { leaveType: true, employmentRelationship: true },
    });
    if (!request) return;

    const resolved = await unscopedPrisma.leavePolicy
      .findMany({
        where: {
          tenantId,
          status: 'active',
          effectiveFrom: { lte: request.startDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: request.startDate } }],
          rules: { some: { leaveTypeId: request.leaveTypeId } },
        },
        include: { rules: { where: { leaveTypeId: request.leaveTypeId } } },
      })
      .then((policies) =>
        policies
          .filter((p) => p.engagementTypes.length === 0 || p.engagementTypes.includes(request.employmentRelationship.engagementType))
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0],
      );

    const chain =
      (resolved && (await unscopedPrisma.leaveApprovalChain.findFirst({ where: { tenantId, leavePolicyId: resolved.id } }))) ??
      (await unscopedPrisma.leaveApprovalChain.findFirst({ where: { tenantId, isDefault: true } }));

    if (chain) {
      const already = await unscopedPrisma.leaveRequestApproval.count({ where: { tenantId, leaveRequestId: request.id } });
      if (already === 0) {
        const levels = chain.levels as unknown as ChainLevel[];
        for (const level of levels) {
          let approverPartyId: string | null = null;
          if (level.kind === 'manager') {
            const assignment = await unscopedPrisma.assignment.findFirst({
              where: { tenantId, employmentRelationshipId: request.employmentRelationshipId, rowStatus: 'Effective' },
              orderBy: { effectiveFrom: 'desc' },
            });
            if (assignment?.managerPositionId) {
              const managerAssignment = await unscopedPrisma.assignment.findFirst({
                where: { tenantId, positionId: assignment.managerPositionId, rowStatus: 'Effective' },
                include: { employmentRelationship: true },
              });
              approverPartyId = managerAssignment?.employmentRelationship.personId ?? null;
            }
          } else if (level.kind === 'hr') {
            approverPartyId = await hrOpsOwnerId(tenantId);
          } else {
            approverPartyId = level.approverPartyId ?? null;
          }
          await unscopedPrisma.leaveRequestApproval.create({
            data: {
              tenantId,
              leaveRequestId: request.id,
              chainId: chain.id,
              level: level.level,
              kind: level.kind,
              approverPartyId,
              decision: 'pending',
            },
          });
        }
      }
    }

    // Flag a request that already violates its policy — after the fact, since
    // there is nowhere upstream this module may veto the write (see module doc).
    if (resolved?.rules[0]) {
      const rule = resolved.rules[0];
      const workingDays = await leaveWorkingDayCount(request.startDate, request.endDate);
      const balance = await unscopedPrisma.leaveBalance.findUnique({
        where: {
          employmentRelationshipId_leaveTypeId: {
            employmentRelationshipId: request.employmentRelationshipId,
            leaveTypeId: request.leaveTypeId,
          },
        },
      });
      const availableDays = (num(balance?.balanceDays) ?? 0) - (num(balance?.heldDays) ?? 0);
      const result = validateLeaveRequestAgainstPolicy(
        {
          accrualFrequency: rule.accrualFrequency as AccrualFrequency,
          accrualDays: num(rule.accrualDays) ?? 0,
          prorateOnJoin: rule.prorateOnJoin,
          maxBalanceDays: num(rule.maxBalanceDays),
          carryForwardCapDays: num(rule.carryForwardCapDays),
          negativeAllowed: rule.negativeAllowed,
          minNoticeDays: rule.minNoticeDays,
          maxConsecutiveDays: rule.maxConsecutiveDays,
          sandwichRule: rule.sandwichRule,
          requiresDocumentAfterDays: rule.requiresDocumentAfterDays,
          applicableGender: rule.applicableGender,
        },
        {
          startDate: request.startDate,
          endDate: request.endDate,
          workingDays,
          submittedAt: request.createdAt,
          availableDays,
        },
      );
      if (!result.ok) {
        await raiseException({
          code: 'EX-HCM-LVP-001',
          label: 'Leave request does not meet its policy',
          severity: 'S2_WARNING',
          subjectType: 'leave_request',
          subjectId: request.id,
          subjectLabel: request.recordCode,
          detail: result.violations.map((v) => v.message).join(' '),
          ownerPartyId: request.employmentRelationship.personId,
          triggerFingerprint: `leave_policy_violation:${request.id}`,
          ladderRung: 1,
        });
      }
    }
  } catch {
    // Never let this subscriber's failure surface to the request that created
    // the leave request — it already committed. A repeated failure lands in
    // the bus's own dead-letter path.
  }
});
