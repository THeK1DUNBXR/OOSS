/**
 * The five-axis permission evaluator (CRM-FOUND-003).
 *
 * This is the single choke point every check runs through. Nothing in service
 * code compares a role slug: `evaluate(principal, action, resource_or_record,
 * context)` replaced `requirePermission`/`assertCan`/`assertRecordScope`/
 * `canSeeFinancials` wholesale, and a static search for `roleSlug ===` in
 * service code returns zero matches.
 *
 * All five axes must evaluate true. Evaluation happens at query/render time,
 * never cached at login: a revoked affiliation goes dark on the very next
 * query, with no deprovisioning job in between.
 */

import {
  SENSITIVITY_RANK,
  MONEY_FIELDS,
  REGULATED_EXCLUDED_FIELDS,
  type AxisOutcome,
  type PermissionDecision,
  type Scope,
  type SensitivityClass,
  type Verb,
  type WithholdReason,
} from '@kaizen/shared';
import { prisma } from './db.js';
import { currentAuth, type AuthContext } from './context.js';
import { ApiError } from './errors.js';

// ---------------------------------------------------------------------------
// Grant resolution. Grants are durable data, read per request — never a static
// matrix computed at module load, and never a file that overwrites the database
// on every deploy.
// ---------------------------------------------------------------------------

export interface ResolvedGrant {
  resource: string;
  verbs: Verb[];
  scope: Scope;
  scopeResolver: string | null;
  policyVersionId: string | null;
  policyVersion: number | null;
  policyId: string | null;
  conditions: Record<string, unknown>;
}

const grantCache = new Map<string, { at: number; grants: ResolvedGrant[] }>();
const GRANT_CACHE_TTL_MS = 2_000; // request-burst coalescing only, not login caching

export function invalidateGrantCache(): void {
  grantCache.clear();
}

export async function resolveGrants(auth: AuthContext): Promise<ResolvedGrant[]> {
  // An AGENT_PRINCIPAL is never assigned a role. It holds individual grants
  // bound to its own identity, and its AUTHORITY_GRANT bounds magnitude.
  const cacheKey = `${auth.tenantId}:${auth.roleSlug ?? '-'}:${auth.agentId ?? '-'}:${auth.partyId ?? '-'}`;
  const cached = grantCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GRANT_CACHE_TTL_MS) return cached.grants;

  const now = new Date();
  const role = auth.roleSlug
    ? await prisma.accessRole.findFirst({ where: { tenantId: auth.tenantId, slug: auth.roleSlug } })
    : null;

  const rows = await prisma.grant.findMany({
    where: {
      tenantId: auth.tenantId,
      OR: [
        ...(role ? [{ roleId: role.id }] : []),
        ...(auth.agentId ? [{ principalId: auth.agentId, principalType: 'agent' }] : []),
        ...(auth.partyId ? [{ principalId: auth.partyId, principalType: 'individual' }] : []),
      ],
      effectiveFrom: { lte: now },
    } as never,
    include: { policyVersion: { select: { id: true, version: true, policyId: true } } },
  });

  const grants: ResolvedGrant[] = rows
    .filter((g) => !g.effectiveTo || g.effectiveTo > now)
    .map((g) => ({
      resource: g.resource,
      verbs: g.verbs as Verb[],
      scope: g.scope as Scope,
      scopeResolver: g.scopeResolver,
      policyVersionId: g.policyVersion?.id ?? null,
      policyVersion: g.policyVersion?.version ?? null,
      policyId: g.policyVersion?.policyId ?? null,
      conditions: (g.conditions as Record<string, unknown>) ?? {},
    }));

  grantCache.set(cacheKey, { at: Date.now(), grants });
  return grants;
}

// ---------------------------------------------------------------------------
// The record shape the WHERE axis narrows against.
// ---------------------------------------------------------------------------

export interface ScopedRecord {
  ownerPartyId?: string | null;
  assigneePartyId?: string | null;
  actorPartyId?: string | null;
  ownerId?: string | null;
  branch?: string | null;
  tenantId?: string;
  sensitivityClass?: string | null;
  /** For the `batch_member` scope resolver. */
  cohortId?: string | null;
  trainerPartyId?: string | null;
}

export interface EvaluateInput {
  resource: string;
  verb: Verb;
  record?: ScopedRecord | null;
  /** The classification of the specific field or record being requested. */
  classification?: SensitivityClass;
  /** The magnitude of the action, for the HOW MUCH axis. */
  magnitude?: { authorityClass: string; value: number; currency?: string } | null;
  /** The purpose this access is bound to, for the WHY axis. */
  requiredPurpose?: string | null;
  requiredConsent?: string[];
  auth?: AuthContext;
}

/**
 * The single evaluation function. Returns a full decision with per-axis
 * outcomes, so a denial can be explained rather than merely refused.
 */
export async function evaluate(input: EvaluateInput): Promise<PermissionDecision> {
  const auth = input.auth ?? currentAuth();
  const axes: AxisOutcome[] = [];

  // The SYSTEM_PRINCIPAL is the only principal that may act with no
  // on_behalf_of. It is still tenant-scoped — the gate above ran first.
  if (auth.principalType === 'system') {
    return {
      allowed: true,
      axes: [
        { axis: 'WHO', passed: true, reason: 'SYSTEM_PRINCIPAL' },
        { axis: 'WHERE', passed: true },
        { axis: 'WHAT', passed: true },
        { axis: 'HOW_MUCH', passed: true },
        { axis: 'WHY', passed: true, reason: auth.purpose ?? 'scheduled_automation' },
      ],
      policyId: null,
      policyVersion: null,
    };
  }

  const grants = await resolveGrants(auth);
  const matching = grants.filter((g) => g.resource === input.resource && g.verbs.includes(input.verb));

  // ---- WHO -----------------------------------------------------------------
  if (matching.length === 0) {
    axes.push({
      axis: 'WHO',
      passed: false,
      reason: `No grant for ${input.resource}:${input.verb}`,
    });
    return deny(axes, 'WHO', 'no_permission');
  }
  // Widest matching grant wins — a principal holding both `own` and `all`
  // resolves to `all`.
  const grant = matching.reduce((a, b) => (scopeRank(b.scope) > scopeRank(a.scope) ? b : a));
  axes.push({ axis: 'WHO', passed: true, reason: `${input.resource}:${input.verb}@${grant.scope}` });

  // ---- WHERE ---------------------------------------------------------------
  //
  // Scope narrows every verb, reads included.
  //
  // This used to exempt `view` and `export`: whatever a grant said, a read
  // resolved to `all`. That was survivable while the roles were commercial —
  // a sales floor genuinely does want everyone to see every lead — and it
  // stopped being survivable the moment an `employee` role existed, because
  // `leave:V@own` that returns the company's leave ledger is not a narrowing,
  // it is a privacy incident with a reassuring name.
  //
  // Where a read genuinely should reach everything, the matrix says so with an
  // explicit `@all` cell alongside the narrower mutation cell. The permission
  // is then a thing you can read off the matrix rather than a rule you have to
  // know about the evaluator.
  const whereOk = input.record ? checkScope(grant, input.record, auth) : true;
  if (!whereOk) {
    axes.push({ axis: 'WHERE', passed: false, reason: `Record outside ${grant.scope} scope` });
    return deny(axes, 'WHERE', 'out_of_scope');
  }
  axes.push({ axis: 'WHERE', passed: true, reason: grant.scope });

  // ---- WHAT ----------------------------------------------------------------
  const classification: SensitivityClass =
    input.classification ?? ((input.record?.sensitivityClass as SensitivityClass | undefined) ?? 'internal');
  const ceilingOk = SENSITIVITY_RANK[auth.classificationCeiling] >= SENSITIVITY_RANK[classification];
  if (!ceilingOk) {
    axes.push({
      axis: 'WHAT',
      passed: false,
      reason: `Classification ceiling ${auth.classificationCeiling} does not clear ${classification}`,
    });
    return deny(axes, 'WHAT', 'classification_ceiling');
  }
  axes.push({ axis: 'WHAT', passed: true, reason: `${classification} <= ${auth.classificationCeiling}` });

  // ---- HOW MUCH ------------------------------------------------------------
  if (input.magnitude) {
    const ceiling = await resolveAuthorityCeiling(auth, input.magnitude.authorityClass);
    if (ceiling === null) {
      // A principal with no resolvable AUTHORITY_GRANT defaults to "no elevated
      // authority" — fail-closed, not fail-open.
      axes.push({
        axis: 'HOW_MUCH',
        passed: false,
        reason: `No AUTHORITY_GRANT for ${input.magnitude.authorityClass}`,
      });
      return deny(axes, 'HOW_MUCH', 'authority_insufficient');
    }
    if (input.magnitude.value > ceiling) {
      axes.push({
        axis: 'HOW_MUCH',
        passed: false,
        reason: `Value ${input.magnitude.value} exceeds ceiling ${ceiling}`,
      });
      return deny(axes, 'HOW_MUCH', 'authority_insufficient');
    }
    axes.push({ axis: 'HOW_MUCH', passed: true, reason: `${input.magnitude.value} <= ${ceiling}` });
  } else {
    axes.push({ axis: 'HOW_MUCH', passed: true, reason: 'no magnitude on this action' });
  }

  // ---- WHY -----------------------------------------------------------------
  if (input.requiredPurpose && auth.purpose !== input.requiredPurpose) {
    axes.push({ axis: 'WHY', passed: false, reason: `Session purpose '${auth.purpose ?? 'none'}' is not bound to '${input.requiredPurpose}'` });
    return deny(axes, 'WHY', 'purpose_unbound');
  }
  if (input.requiredConsent?.length) {
    const missing = input.requiredConsent.filter((c) => !auth.consentCodes.includes(c));
    if (missing.length) {
      axes.push({ axis: 'WHY', passed: false, reason: `Consent absent: ${missing.join(', ')}` });
      return deny(axes, 'WHY', 'consent_absent');
    }
  }
  // Regulated data always requires an explicit purpose binding — fail closed.
  if (classification === 'regulated' && !auth.purpose) {
    axes.push({ axis: 'WHY', passed: false, reason: 'Regulated data requires an explicit purpose binding' });
    return deny(axes, 'WHY', 'purpose_unbound');
  }
  axes.push({ axis: 'WHY', passed: true, reason: auth.purpose ?? 'not purpose-bound' });

  return {
    allowed: true,
    axes,
    policyId: grant.policyId,
    policyVersion: grant.policyVersion,
  };
}

function deny(axes: AxisOutcome[], deniedBy: PermissionDecision['deniedBy'], reasonCode: string): PermissionDecision {
  return { allowed: false, axes, deniedBy, reasonCode, policyId: null, policyVersion: null };
}

function scopeRank(scope: Scope): number {
  return scope === 'all' ? 2 : scope === 'own_or_unowned' ? 1 : 0;
}

function ownerOf(record: ScopedRecord): string | null {
  return record.ownerPartyId ?? record.assigneePartyId ?? record.actorPartyId ?? record.ownerId ?? null;
}

function checkScope(grant: ResolvedGrant, record: ScopedRecord, auth: AuthContext): boolean {
  if (grant.scope === 'all') return true;

  const owner = ownerOf(record);

  // A scope resolver expresses a narrowing as data rather than as a role-slug
  // comparison in service code. `batch_member` is the one the six hard-coded
  // trainer checks were replaced by.
  if (grant.scopeResolver === 'batch_member') {
    return record.trainerPartyId === auth.partyId;
  }

  if (grant.scope === 'own') {
    return owner !== null && owner === auth.partyId;
  }

  // own_or_unowned: the requester's own records, or records with no assigned
  // owner — with a same-branch check applied ONLY in the unowned case.
  if (owner === null) {
    if (!record.branch || !auth.branch) return true;
    return record.branch === auth.branch;
  }
  return owner === auth.partyId;
}

export async function resolveAuthorityCeiling(auth: AuthContext, authorityClass: string): Promise<number | null> {
  const principalId = auth.agentId ?? auth.partyId;
  if (!principalId) return null;
  const now = new Date();
  const grant = await prisma.authorityGrant.findFirst({
    where: {
      tenantId: auth.tenantId,
      principalId,
      authorityClass,
      status: 'active',
      effectiveFrom: { lte: now },
    },
    orderBy: { ceilingValue: 'desc' },
  });
  if (!grant || (grant.effectiveTo && grant.effectiveTo <= now)) return null;
  return grant.ceilingValue ? Number(grant.ceilingValue.toString()) : 0;
}

// ---------------------------------------------------------------------------
// Assertion helpers used at every route and service boundary.
// ---------------------------------------------------------------------------

export async function assertCan(input: EvaluateInput): Promise<PermissionDecision> {
  const decision = await evaluate(input);
  if (!decision.allowed) {
    // A denial that would otherwise have produced an event logs its policy
    // version via the event envelope's reason field.
    throw ApiError.forbidden(
      `Denied on ${decision.deniedBy} axis for ${input.resource}:${input.verb}`,
      decision.axes,
    );
  }
  return decision;
}

export async function can(input: EvaluateInput): Promise<boolean> {
  return (await evaluate(input)).allowed;
}

/**
 * True when the caller's resolved grants include one on `resource` carrying
 * `resolver`.
 *
 * A scope resolver is how a narrowing that would otherwise be a role-slug
 * comparison is expressed as data. `management_chain` is the second such
 * resolver: it marks the roles whose supervisory position over an org unit
 * lets them see an interaction recorded about someone in that unit. Which
 * roles those are is a matrix question, so it is answered from the matrix.
 */
export async function holdsScopeResolver(
  resource: string,
  verb: Verb,
  resolver: string,
  auth?: AuthContext,
): Promise<boolean> {
  const a = auth ?? currentAuth();
  const grants = await resolveGrants(a);
  return grants.some((g) => g.resource === resource && g.verbs.includes(verb) && g.scopeResolver === resolver);
}

/** Resolves the effective scope for a list query, so the query itself is narrowed. */
export async function scopeFor(resource: string, verb: Verb, auth?: AuthContext): Promise<Scope | null> {
  const a = auth ?? currentAuth();
  if (a.principalType === 'system') return 'all';
  const grants = await resolveGrants(a);
  const matching = grants.filter((g) => g.resource === resource && g.verbs.includes(verb));
  if (matching.length === 0) return null;
  return matching.reduce((x, y) => (scopeRank(y.scope) > scopeRank(x.scope) ? y : x)).scope;
}

/**
 * Builds a Prisma `where` fragment implementing the WHERE axis for a list
 * query.
 */
export function scopeWhere(scope: Scope, auth: AuthContext, ownerField = 'ownerPartyId'): Record<string, unknown> {
  if (scope === 'all') return {};
  if (scope === 'own') return { [ownerField]: auth.partyId };
  return {
    OR: [
      { [ownerField]: auth.partyId },
      { [ownerField]: null, ...(auth.branch ? { branch: auth.branch } : {}) },
    ],
  };
}


/**
 * Asserts a grant wide enough to answer a question about everybody.
 *
 * An aggregate — headcount by division, the profit and loss, a budget variance
 * — is a statement about records the caller may not individually be allowed to
 * see. `assertCan({ verb: 'view' })` cannot catch that: with no record to
 * narrow against it answers "may this person read this kind of thing at all",
 * and an employee holding `employees:V@own` sails through it and receives the
 * company's headcount.
 *
 * So an aggregate asks for the scope, not merely the grant. This is the
 * counterpart to `visibilityWhere` for figures that cannot be narrowed row by
 * row: where a list can be filtered down to what the caller may see, a total
 * cannot be — it is either theirs to know or it is not.
 */
export async function assertScopeAll(resource: string, verb: Verb = 'view', auth?: AuthContext): Promise<void> {
  const a = auth ?? currentAuth();
  await assertCan({ resource, verb });
  const scope = await scopeFor(resource, verb, a);
  if (scope !== 'all') {
    throw ApiError.forbidden(
      `${resource}:${verb} is held at \`${scope}\` scope. This figure is drawn across every record, so it needs an all-scope grant — a narrowed one cannot produce a total that means anything.`,
      [{ axis: 'WHERE', passed: false, reason: `aggregate needs all scope, holds ${scope}` }],
    );
  }
}

/**
 * The WHERE fragment a list query needs so that what comes back matches what
 * the evaluator would have allowed row by row.
 *
 * `assertCan({ verb: 'view' })` with no record can only answer "may this
 * person read this kind of thing at all" — it has no row to narrow against. A
 * list endpoint that stops there returns everything to anybody holding the
 * resource, whatever scope their grant carries, and the narrowing exists only
 * on paper. This closes that gap in one call:
 *
 *   const where = await visibilityWhere('leave', 'personId');
 *   return prisma.leaveRequest.findMany({ where: { tenantId, ...where } });
 *
 * Returning `{}` for an `all` grant keeps the common case free.
 */
export async function visibilityWhere(
  resource: string,
  ownerField = 'ownerPartyId',
  auth?: AuthContext,
): Promise<Record<string, unknown>> {
  const a = auth ?? currentAuth();
  const scope = await scopeFor(resource, 'view', a);
  // No grant at all: the caller should have asserted first. Returning an
  // unsatisfiable filter rather than `{}` means a missing assertion degrades to
  // an empty list instead of to the whole table.
  if (scope === null) return { [ownerField]: '\u0000no-grant' };
  return scopeWhere(scope, a, ownerField);
}

// ---------------------------------------------------------------------------
// The three visibility behaviours: masking, withholding, concealing (§10.4.4).
// ---------------------------------------------------------------------------

export interface FilterResult<T> {
  data: T;
  withheld: Array<{ path: string; reason: WithholdReason }>;
}

export interface FilterOptions {
  /** Whether this viewer holds financial visibility on the resource. */
  canSeeMoney: boolean;
  /** The viewer's WHAT-axis ceiling. */
  ceiling: SensitivityClass;
  /** Field-level classifications, keyed by field name. */
  fieldClassifications?: Record<string, SensitivityClass>;
  /** Statutory/business purpose for each field, used by data maps and exports. */
  fieldPurposes?: Record<string, string>;
  /** Paths to withhold with a reason rather than null. */
  withholdPaths?: Array<{ path: string; reason: WithholdReason }>;
}

/** Purpose tags shared by field-level visibility and data-principal exports. */
export const FIELD_PURPOSES: Record<string, string> = {
  fullName: 'employment|education_delivery|invoicing',
  email: 'employment|education_delivery|marketing',
  phone: 'employment|education_delivery|marketing',
  dateOfBirth: 'employment|education_delivery',
  panNumber: 'employment|statutory_filing',
  aadhaarReference: 'employment|statutory_filing',
  bankAccountNumber: 'employment|invoicing',
  bankAccountName: 'employment|invoicing',
  bankIfsc: 'employment|invoicing',
  guardianName: 'education_delivery',
  guardianPhone: 'education_delivery',
  guardianConsentId: 'education_delivery',
};

/**
 * Masking nulls a value in place; withholding replaces it with a reason code;
 * regulated fields are structurally excluded from the response shape entirely,
 * which is a stronger guarantee than masking — a masked field's presence still
 * tells a viewer something is being withheld.
 */
export function applyFieldVisibility<T extends Record<string, unknown>>(
  payload: T,
  options: FilterOptions,
): FilterResult<T> {
  const withheld: Array<{ path: string; reason: WithholdReason }> = [];
  const out = walk(payload, '', options, withheld) as T;
  for (const w of options.withholdPaths ?? []) withheld.push(w);
  return { data: out, withheld };
}

function walk(
  value: unknown,
  path: string,
  options: FilterOptions,
  withheld: Array<{ path: string; reason: WithholdReason }>,
): unknown {
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, options, withheld));
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;

    // Regulated: structurally excluded — the key does not appear at all.
    if (REGULATED_EXCLUDED_FIELDS.includes(key)) {
      if (SENSITIVITY_RANK[options.ceiling] < SENSITIVITY_RANK.regulated) {
        continue;
      }
    }

    const fieldClass = options.fieldClassifications?.[key];
    if (fieldClass && SENSITIVITY_RANK[options.ceiling] < SENSITIVITY_RANK[fieldClass]) {
      withheld.push({ path: childPath, reason: 'classification_ceiling' });
      out[key] = null;
      continue;
    }

    // Money masking: present but nulled.
    if (!options.canSeeMoney && MONEY_FIELDS.includes(key) && typeof v !== 'object') {
      withheld.push({ path: childPath, reason: 'no_permission' });
      out[key] = null;
      continue;
    }

    out[key] = walk(v, childPath, options, withheld);
  }
  return out;
}

/** Whether this principal may see unmasked money on a resource. */
export async function canSeeMoney(resource: string, auth?: AuthContext): Promise<boolean> {
  const a = auth ?? currentAuth();
  if (a.principalType === 'system') return true;
  return can({ resource, verb: 'financial', auth: a });
}
