/**
 * Privileged-transition approval gates (§10.5).
 *
 * `POL-CRM-MOU-APPROVAL` is the reference implementation; the Contract and
 * Partner Agreement gates are direct instances of the identical shape with only
 * the subject type and value field swapped. A developer adding a fourth
 * instantiates this shape — they do not re-derive it.
 *
 * The formal rule, reproduced because it is the exact enforceable statement:
 * an actor may execute the approved/signed transition if and only if
 *   (`<resource>:approve` grant held)
 *   AND (AUTHORITY_GRANT ceiling >= subject.commercial_value OR actor is the resolved-tier approver)
 *   AND (actor.principal_id != subject.owner_id)          -- the Self-Dealing Bar
 *   AND (actor.principal_type != 'agent').
 *
 * The old rule carried a fifth clause excluding `system_admin`. That role is
 * gone with the three-role register, and the exclusion it expressed is now
 * structural: `employee` holds no `approve` verb on anything, so there is no
 * excluded-role list left to keep in agreement with the matrix.
 */

import { EVENTS, APPROVAL_EXCLUDED_ROLES, APPROVAL_LADDER, type SeverityCode } from '@kaizen/shared';
import { prisma } from './db.js';
import { currentAuth } from './context.js';
import { emit } from './eventBus.js';
import { evaluate, resolveAuthorityCeiling } from './permissions.js';
import { ApiError } from './errors.js';
import { notify, raiseException } from './exceptions.js';

export interface ApprovalPolicyContent {
  requiredPermission: string;
  authorityClass: string;
  /** Tiered chain, escalating on strategic value or long term. */
  approverResolution: string[];
  escalateToTopTierWhen: { strategicValue?: string; termMonthsOver?: number };
  /** Unconditional; no override path inside this policy. */
  selfDealingBar: true;
  /** Structurally excluded at every tier, regardless of any AUTHORITY_GRANT held. */
  excludedRoles: string[];
  /** The approval decision is PROHIBITED for any AI principal at any grant size. */
  appliesTo: { principalTypes: string[] };
  /** AU-CRM-015: an unresolved step bumps a tier after this grace window. */
  escalationGraceBusinessDays: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicyContent = {
  requiredPermission: 'mous:approve',
  authorityClass: 'mou_approval',
  // Two rungs, not four. Finance Head approves within its ceiling; anything
  // above it is the chairman's.
  approverResolution: [...APPROVAL_LADDER],
  escalateToTopTierWhen: { strategicValue: 'high', termMonthsOver: 36 },
  selfDealingBar: true,
  excludedRoles: [...APPROVAL_EXCLUDED_ROLES],
  appliesTo: { principalTypes: ['human'] },
  escalationGraceBusinessDays: 3,
};

export interface GateSubject {
  id: string;
  type: 'mou' | 'contract' | 'partner_agreement' | 'quote' | 'share_transaction';
  label: string;
  ownerPartyId: string | null;
  commercialValue: number | null;
  currency: string;
  strategicValue: string | null;
  termMonths: number | null;
  /**
   * Overrides the `${type}s` resource the gate would otherwise derive. A
   * `share_transaction` gates on `share_ledger:approve` (§3.4 of the
   * equity-portal plan), not the ungranted `share_transactions` resource the
   * default derivation would ask for.
   */
  resource?: string;
}

export interface GateResult {
  permitted: boolean;
  /** When not permitted directly, the step opened and the approver resolved onto it. */
  approvalStepId: string | null;
  resolvedApproverRole: string | null;
  resolvedApproverId: string | null;
  resolutionTier: number;
  selfDealingBarTripped: boolean;
  reason: string;
}

async function loadPolicy(policyCode: string): Promise<{ id: string; version: number; content: ApprovalPolicyContent } | null> {
  const auth = currentAuth();
  const policy = await prisma.policy.findFirst({
    where: { tenantId: auth.tenantId, policyCode },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const version = policy?.versions[0];
  if (!policy || !version) return null;
  return { id: policy.id, version: version.version, content: version.content as unknown as ApprovalPolicyContent };
}

/**
 * Evaluates the gate. Never throws for a legitimate over-ceiling case — it
 * opens an APPROVAL_STEP against the resolved authority holder instead, so the
 * escalation ladder is a control on the failing action rather than a dead end.
 */
export async function evaluateApprovalGate(
  policyCode: string,
  subject: GateSubject,
  action: string,
): Promise<GateResult> {
  const auth = currentAuth();
  const loaded = await loadPolicy(policyCode);
  const content = loaded?.content ?? DEFAULT_APPROVAL_POLICY;

  // The approval decision itself is PROHIBITED for any AI principal regardless
  // of AUTHORITY_GRANT size — an agent recommending is categorically different
  // from an agent approving.
  if (auth.principalType === 'agent') {
    throw ApiError.forbidden(
      `An AI principal may never execute ${action}. This transition commits the organisation, and a named human role sits at every value tier.`,
      [{ axis: 'WHO', passed: false, reason: 'agent_principal_excluded' }],
    );
  }

  // Retained as a mechanism even though the list is empty under the
  // three-role register: a tenant may add an excluded role to its own policy
  // version without a code change, and the gate must honour it.
  if (auth.roleSlug && content.excludedRoles.includes(auth.roleSlug)) {
    throw ApiError.forbidden(
      `${auth.roleSlug} is excluded from every approval tier by policy, and may never execute ${action}.`,
      [{ axis: 'WHO', passed: false, reason: 'role_excluded_by_policy' }],
    );
  }

  // required_permission — a distinct grant from base edit. Holding edit alone
  // never confers approval authority.
  const resource = subject.resource ?? `${subject.type}s`;
  const permission = await evaluate({ resource, verb: 'approve' });
  if (!permission.allowed) {
    throw ApiError.forbidden(
      `${resource}:approve is a distinct grant from ${resource}:edit and is not held.`,
      permission.axes,
    );
  }

  // The Self-Dealing Bar: unconditional, with no override path inside this
  // policy. When tripped, resolution reroutes to the next tier rather than
  // blocking outright, and the attempt is audited as a watched pattern.
  const selfDealing = Boolean(subject.ownerPartyId && auth.partyId && subject.ownerPartyId === auth.partyId);

  // authority_test — the HOW MUCH axis.
  const value = subject.commercialValue ?? 0;
  const ceiling = await resolveAuthorityCeiling(auth, content.authorityClass);
  const withinCeiling = ceiling !== null && value <= ceiling;

  // approver_resolution — escalating to the top tier on an OR gate, deliberately:
  // a zero-value, high-strategic academic MoU escalates as readily as a
  // high-value commercial one.
  const forceTopTier =
    (content.escalateToTopTierWhen.strategicValue && subject.strategicValue === content.escalateToTopTierWhen.strategicValue) ||
    (content.escalateToTopTierWhen.termMonthsOver != null &&
      (subject.termMonths ?? 0) > content.escalateToTopTierWhen.termMonthsOver);

  let tier = forceTopTier ? content.approverResolution.length - 1 : tierForValue(value, ceiling, content);
  if (selfDealing) tier = Math.min(tier + 1, content.approverResolution.length - 1);

  const approverRole = content.approverResolution[tier] ?? content.approverResolution.at(-1)!;

  const actorIsResolvedTierApprover = auth.roleSlug === approverRole && !selfDealing;

  if (!forceTopTier && withinCeiling && !selfDealing) {
    return {
      permitted: true,
      approvalStepId: null,
      resolvedApproverRole: auth.roleSlug,
      resolvedApproverId: auth.partyId,
      resolutionTier: tier,
      selfDealingBarTripped: false,
      reason: `Within AUTHORITY_GRANT ceiling (${value} <= ${ceiling}).`,
    };
  }

  if (actorIsResolvedTierApprover && !forceTopTier) {
    return {
      permitted: true,
      approvalStepId: null,
      resolvedApproverRole: approverRole,
      resolvedApproverId: auth.partyId,
      resolutionTier: tier,
      selfDealingBarTripped: false,
      reason: 'Actor is the resolved-tier approver.',
    };
  }

  const approver = await resolveApprover(approverRole, subject.ownerPartyId);
  const step = await prisma.approvalStep.create({
    data: {
      tenantId: auth.tenantId,
      policyId: loaded?.id ?? null,
      policyVersion: loaded?.version ?? null,
      subjectType: subject.type,
      subjectId: subject.id,
      subjectLabel: subject.label,
      action,
      requestedById: auth.partyId ?? 'system',
      requestedValue: subject.commercialValue ?? undefined,
      currency: subject.currency,
      resolvedApproverId: approver?.partyId ?? null,
      resolvedApproverRole: approverRole,
      resolutionTier: tier,
      selfDealingBarTripped: selfDealing,
      slaDueAt: addBusinessDays(new Date(), content.escalationGraceBusinessDays),
    },
  });

  await emit({
    name: EVENTS.APPROVAL_STEP_OPENED,
    subject: { entityType: 'approval_step', entityId: step.id },
    related: [{ relation: 'gates', entityType: subject.type, entityId: subject.id }],
    newState: {
      action,
      approverRole,
      tier,
      selfDealingBarTripped: selfDealing,
      value: subject.commercialValue,
    },
    reason: selfDealing ? { reasonCode: 'self_dealing_bar' } : { reasonCode: 'authority_insufficient' },
    impact: { domains: ['gov', 'crm'], severity: 'S2_WARNING' },
    confidentiality: 'confidential',
  });

  // A HOW MUCH ceiling exceeded is signalled, never silently clamped or
  // rejected without signal.
  if (ceiling !== null && value > ceiling) {
    await emit({
      name: EVENTS.AUTHORITY_GRANT_EXCEEDED,
      subject: { entityType: 'authority_grant', entityId: auth.partyId ?? 'unknown' },
      newState: { authorityClass: content.authorityClass, ceiling, attempted: value },
      impact: { domains: ['gov'], severity: 'S2_WARNING' },
    });
  }

  if (approver?.partyId) {
    await notify({
      recipientPartyId: approver.partyId,
      priority: 'N3_HIGH',
      title: `Approval required: ${subject.label}`,
      body: selfDealing
        ? `The Self-Dealing Bar rerouted this ${subject.type} to you (tier ${tier + 1}, ${approverRole}).`
        : `${action} on ${subject.label} exceeds the requester's authority. Resolved to ${approverRole}.`,
      severity: 'S2_WARNING',
      subjectType: 'approval_step',
      subjectId: step.id,
      drillPath: `/approvals/${step.id}`,
    });
  } else {
    await raiseException({
      code: 'EX-GOV-001',
      label: 'Nobody could be found to approve this',
      severity: 'S3_HIGH_RISK' as SeverityCode,
      subjectType: 'approval_step',
      subjectId: step.id,
      subjectLabel: subject.label,
      domain: 'gov',
      detail: `No active principal holds ${approverRole} for tier ${tier + 1}.`,
      reasonCode: 'approver_unresolved',
    });
  }

  return {
    permitted: false,
    approvalStepId: step.id,
    resolvedApproverRole: approverRole,
    resolvedApproverId: approver?.partyId ?? null,
    resolutionTier: tier,
    selfDealingBarTripped: selfDealing,
    reason: selfDealing
      ? 'Self-Dealing Bar: the approver may never be the subject owner. Rerouted to the next tier.'
      : `Value ${value} exceeds the requester's ${content.authorityClass} ceiling${ceiling === null ? ' (none held)' : ` of ${ceiling}`}.`,
  };
}

function tierForValue(value: number, ceiling: number | null, content: ApprovalPolicyContent): number {
  if (ceiling === null) return 0;
  if (value <= ceiling) return 0;
  const overBy = value / Math.max(ceiling, 1);
  if (overBy > 10) return content.approverResolution.length - 1;
  if (overBy > 3) return Math.min(1, content.approverResolution.length - 1);
  return 0;
}

async function resolveApprover(roleSlug: string, excludePartyId: string | null) {
  const auth = currentAuth();
  const affiliation = await prisma.affiliation.findFirst({
    where: {
      tenantId: auth.tenantId,
      roleSlug,
      status: 'active',
      ...(excludePartyId ? { partyId: { not: excludePartyId } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  return affiliation ? { partyId: affiliation.partyId } : null;
}

export async function decideApprovalStep(stepId: string, approve: boolean, note: string) {
  const auth = currentAuth();
  const step = await prisma.approvalStep.findFirst({ where: { id: stepId } });
  if (!step) throw ApiError.notFound('Approval step');
  if (step.state !== 'open' && step.state !== 'escalated') {
    throw ApiError.conflict(`Approval step is already ${step.state}.`);
  }

  // Approval routes to whoever holds authority at decision time, not at block
  // time — the five-axis "evaluated at query/render time, never at login" rule.
  if (auth.roleSlug && APPROVAL_EXCLUDED_ROLES.includes(auth.roleSlug as never)) {
    throw ApiError.forbidden(`${auth.roleSlug} is never a valid approval-resolution target at any tier.`);
  }
  if (step.requestedById === auth.partyId) {
    throw ApiError.forbidden('The Self-Dealing Bar is unconditional: a requester may never approve their own step.');
  }

  const updated = await prisma.approvalStep.update({
    where: { id: stepId },
    data: {
      state: approve ? 'approved' : 'declined',
      decidedById: auth.partyId,
      decidedAt: new Date(),
      decisionNote: note,
    },
  });

  await emit({
    name: EVENTS.APPROVAL_STEP_DECIDED,
    subject: { entityType: 'approval_step', entityId: stepId },
    related: [{ relation: 'gates', entityType: step.subjectType, entityId: step.subjectId }],
    previousState: { state: step.state },
    newState: { state: updated.state, note },
    reason: { reasonCode: approve ? 'approved' : 'declined', policyId: step.policyId, policyVersion: step.policyVersion },
    confidentiality: 'confidential',
  });

  if (step.requestedById) {
    await notify({
      recipientPartyId: step.requestedById,
      priority: 'N2_NORMAL',
      title: `${approve ? 'Approved' : 'Declined'}: ${step.subjectLabel ?? step.subjectId}`,
      body: note,
      subjectType: step.subjectType,
      subjectId: step.subjectId,
      drillPath: `/${step.subjectType}s/${step.subjectId}`,
    });
  }

  return updated;
}

function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

export { addBusinessDays };
