/**
 * HCM — workflow (docs/hcm/workflow.md).
 *
 * The generic HR request & approval engine. This file carries the pure,
 * side-effect-free shapes and logic — the approval-chain type, its
 * validation, and the delegation lookup — so the domain layer (which touches
 * the database) and the test suite can both build on the same definitions.
 */

export const HCM_WORKFLOW_MODULE = 'workflow' as const;

/** How a chain level's approver is found at resolution time. */
export type ApprovalResolverKind = 'manager' | 'hr_grant' | 'finance_grant' | 'specific';

export interface ApprovalChainStep {
  level: number;
  resolver: ApprovalResolverKind;
  /** Required, and only meaningful, when `resolver` is `specific`. */
  partyId?: string;
}

export type ApprovalChain = ApprovalChainStep[];

export type HrRequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'closed';
export type HrRequestApprovalDecision = 'pending' | 'approved' | 'rejected';

const RESOLVER_KINDS: ApprovalResolverKind[] = ['manager', 'hr_grant', 'finance_grant', 'specific'];

/**
 * Validates a request type's approval chain shape: at least one step,
 * strictly ascending levels starting at 1, a known resolver kind on every
 * step, and a `partyId` present wherever (and only where) `resolver` is
 * `specific`. Returns the problems found — empty means valid.
 */
export function validateApprovalChain(chain: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(chain) || chain.length === 0) {
    return ['approvalChain must be a non-empty array of steps.'];
  }
  chain.forEach((raw, i) => {
    const step = raw as Partial<ApprovalChainStep>;
    if (typeof step.level !== 'number' || step.level !== i + 1) {
      problems.push(`Step ${i}: level must be ${i + 1} (levels are 1-based and contiguous).`);
    }
    if (typeof step.resolver !== 'string' || !RESOLVER_KINDS.includes(step.resolver as ApprovalResolverKind)) {
      problems.push(`Step ${i}: resolver must be one of ${RESOLVER_KINDS.join(', ')}.`);
    }
    if (step.resolver === 'specific' && !step.partyId) {
      problems.push(`Step ${i}: a "specific" resolver needs a partyId.`);
    }
    if (step.resolver !== 'specific' && step.partyId) {
      problems.push(`Step ${i}: partyId is only meaningful for a "specific" resolver.`);
    }
  });
  return problems;
}

export function isValidApprovalChain(chain: unknown): chain is ApprovalChain {
  return validateApprovalChain(chain).length === 0;
}

/** The step for a given 1-based level, or undefined past the end of the chain. */
export function stepForLevel(chain: ApprovalChain, level: number): ApprovalChainStep | undefined {
  return chain.find((s) => s.level === level);
}

export interface DelegationFact {
  fromPartyId: string;
  toPartyId: string;
  fromDate: Date | string;
  toDate: Date | string;
  scope: string;
  revokedAt?: Date | string | null;
}

/**
 * Follows an active delegation chain from `partyId`, for the given resolver
 * `scope`, as of `now` — a person who delegated onward to someone who
 * delegated further still resolves to the end of the chain, not the first
 * hop. Bounded to `maxHops` so a data error (a delegation cycle) cannot loop
 * forever; on a cycle it returns the last party seen before the repeat.
 */
export function resolveDelegate(
  partyId: string,
  scope: string,
  delegations: DelegationFact[],
  now: Date = new Date(),
  maxHops = 5,
): string {
  let current = partyId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < maxHops; hop += 1) {
    const active = delegations.find(
      (d) =>
        d.fromPartyId === current &&
        !d.revokedAt &&
        (d.scope === scope || d.scope === 'all') &&
        new Date(d.fromDate) <= now &&
        now <= new Date(d.toDate),
    );
    if (!active) return current;
    if (seen.has(active.toPartyId)) return current;
    current = active.toPartyId;
    seen.add(current);
  }
  return current;
}

/**
 * The Self-Dealing Bar for this engine: an approver may never be the request's
 * proposer, nor the person the request is about (the subject employment's own
 * party). Pure so both the domain layer and the test suite check it the same
 * way.
 */
export function tripsSelfDealingBar(
  approverPartyId: string | null,
  requestedById: string,
  subjectPartyId: string | null,
): boolean {
  if (!approverPartyId) return false;
  return approverPartyId === requestedById || (subjectPartyId != null && approverPartyId === subjectPartyId);
}

/** Whether a request has left its chain and is done being decided. */
export function isTerminalStatus(status: HrRequestStatus): boolean {
  return status === 'approved' || status === 'rejected' || status === 'withdrawn' || status === 'closed';
}
