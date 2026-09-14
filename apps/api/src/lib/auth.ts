/**
 * Session and context switching.
 *
 * Context switching is "which of my several relationships with this company am
 * I currently answerable as" — not "which company am I logged into". Kaizen's
 * switcher operates within one tenant, across relationships carrying materially
 * different trust postures and ceilings.
 *
 * `activeAffiliationId` is carried server-side and never client-trusted: a deep
 * link may hint a context, but the server always validates against actual
 * grants. Switching mutates the existing session; no new session is issued.
 */

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  ROLE_CLASSIFICATION_CEILING,
  EVENTS,
  type AffiliationSummary,
  type SessionUser,
  type SurfaceArchetype,
  type SensitivityClass,
  type EntityOption,
  type TenantConfig,
  type TenantKind,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../platform/db.js';
import { asSystem, runWithContext, newRequestContext, type AuthContext } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { resolveGrants } from '../platform/permissions.js';
import { formatGrant } from '@kaizen/shared';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL = '12h';
const SELECTION_TOKEN_TTL = '5m';

/** Privileged contexts require step-up re-auth to commit a switch. */
const STEP_UP_ROLES = new Set(['chairman', 'finance_head', 'hr_ops_manager']);

export interface TokenPayload {
  userId: string;
  tenantId: string;
  affiliationId: string;
  stepUp: boolean;
}

/**
 * Issued instead of a normal token when a principal resolves to more than one
 * entity. Good for five minutes, and carries no `userId`/`tenantId` — it
 * proves who the principal is and nothing about which entity, so it cannot be
 * used anywhere a normal bearer token is accepted.
 */
export interface SelectionTokenPayload {
  principalId: string;
  purpose: 'select-entity';
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    throw ApiError.unauthorized('Session token is invalid or expired.');
  }
}

function signSelectionToken(principalId: string): string {
  return jwt.sign({ principalId, purpose: 'select-entity' } satisfies SelectionTokenPayload, JWT_SECRET, {
    expiresIn: SELECTION_TOKEN_TTL,
  });
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

function generatePassword(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Find-or-create the `Principal` behind a sign-in email, and set its password
 * when it has none yet or `reset` is asked for. The one place outside
 * `lib/http.ts` and the seed that touches `Principal` directly — callers such
 * as `domains/signIns.ts` go through this rather than reaching the model
 * themselves, per the comment on `TENANT_EXEMPT_MODELS`.
 *
 * Returns the plain password only when one was actually generated, so a
 * caller can tell "issued for the first time" and "rotated" apart from "left
 * untouched" — the same three-way `SeededAccount.password` shape the founding
 * accounts already use.
 */
export async function ensureSignInPrincipal(email: string, reset: boolean): Promise<{ principalId: string; password: string | null }> {
  const lower = email.toLowerCase();
  let principal = await unscopedPrisma.principal.findFirst({ where: { email: lower } });
  let password: string | null = null;

  if (!principal) {
    password = generatePassword();
    principal = await unscopedPrisma.principal.create({ data: { email: lower, passwordHash: await hashPassword(password) } });
  } else if (reset) {
    password = generatePassword();
    principal = await unscopedPrisma.principal.update({ where: { id: principal.id }, data: { passwordHash: await hashPassword(password) } });
  }

  return { principalId: principal.id, password };
}

/**
 * Every tenant this principal can currently continue into: a `User` row of
 * theirs carrying an active affiliation, in a tenant that is itself active.
 * Reachable from `lib/auth.ts` only — this is identity resolution, which runs
 * before a tenant is chosen, not a read of tenant data, so the unscoped client
 * is legitimate here the same way it is for `login()` itself.
 */
async function entitiesFor(principalId: string, emailForHint?: string): Promise<EntityOption[]> {
  const users = await unscopedPrisma.user.findMany({
    where: { principalId, status: 'active', tenant: { status: 'active' } },
    include: { tenant: true },
  });

  const options: EntityOption[] = [];
  for (const user of users) {
    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: user.tenantId, partyId: user.personId, status: 'active' },
    });
    if (affiliations.length === 0) continue;

    const config = (user.tenant.config as TenantConfig | null) ?? {};
    const domain = emailForHint?.split('@')[1]?.toLowerCase();
    const suggested = Boolean(domain && (config.emailDomains ?? []).map((d) => d.toLowerCase()).includes(domain));

    options.push({
      tenantId: user.tenantId,
      slug: user.tenant.slug,
      name: user.tenant.name,
      kind: user.tenant.kind as TenantKind,
      parentTenantId: user.tenant.parentTenantId,
      roleSlugs: [...new Set(affiliations.map((a) => a.roleSlug ?? 'sales'))],
      ...(suggested ? { suggested: true } : {}),
    });
  }

  // A suggested entity (matched by the email-domain hint) goes first; it is a
  // pre-selection convenience only, never the reason the entity is reachable.
  options.sort((a, b) => Number(b.suggested ?? false) - Number(a.suggested ?? false));
  return options;
}

/** How many entities a principal can currently continue into — cheaper than `entitiesFor` when only the count is wanted. */
async function countEntities(principalId: string): Promise<number> {
  return (await entitiesFor(principalId)).length;
}

export interface EntitySelectionResult {
  entities: EntityOption[];
  selectionToken: string;
}

export async function login(
  email: string,
  password: string,
  tenantSlug?: string,
): Promise<{ token: string; user: SessionUser } | EntitySelectionResult> {
  // Login runs before a tenant is resolved, so it uses the unscoped client
  // deliberately and narrowly — the only place that is legitimate.
  const principal = await unscopedPrisma.principal.findFirst({
    where: { email: email.toLowerCase(), status: 'active' },
  });

  if (!principal || !(await bcrypt.compare(password, principal.passwordHash))) {
    throw ApiError.unauthorized('Email or password is incorrect.');
  }

  const users = await unscopedPrisma.user.findMany({
    where: {
      principalId: principal.id,
      status: 'active',
      tenant: { status: 'active' },
      ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
    },
    include: { tenant: true, person: true },
  });

  // At least one active affiliation, in the tenant(s) considered.
  const candidates: typeof users = [];
  for (const user of users) {
    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: user.tenantId, partyId: user.personId, status: 'active' },
    });
    if (affiliations.length > 0) candidates.push(user);
  }

  if (candidates.length === 0) {
    // A `User` row still carrying the deprecated `passwordHash` (not yet
    // walked onto a principal by the backfill) matches by email but never by
    // `principalId`, so it silently drops out of `users` above — refused
    // here with the reason named, rather than the generic "no affiliation"
    // a genuinely affiliation-less account gets.
    const unmigrated = await unscopedPrisma.user.findFirst({
      where: { email: email.toLowerCase(), principalId: null, ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}) },
    });
    if (unmigrated) {
      throw ApiError.forbidden('This account has no principal yet — the seed has not backfilled it. Run the seed, then sign in again.');
    }
    throw ApiError.forbidden('This account holds no active affiliation. Access derives from affiliations, never from the person record.');
  }

  if (candidates.length > 1) {
    return {
      entities: await entitiesFor(principal.id, email),
      selectionToken: signSelectionToken(principal.id),
    };
  }

  const user = candidates[0];
  const affiliations = await unscopedPrisma.affiliation.findMany({
    where: { tenantId: user.tenantId, partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });

  // Selection order: exactly one active -> silent; primary_flag; most recently
  // used; otherwise show the switcher. The highest-privilege context is
  // deliberately NOT auto-selected.
  const active =
    affiliations.find((a) => a.id === user.activeAffiliationId) ??
    affiliations.find((a) => a.primaryFlag) ??
    affiliations[0];

  await unscopedPrisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), activeAffiliationId: active.id },
  });
  await unscopedPrisma.principal.update({ where: { id: principal.id }, data: { lastLoginAt: new Date() } });

  await asSystem(user.tenantId, async () => {
    await prisma.auditRecord.create({
      data: {
        tenantId: user.tenantId,
        action: 'login',
        subjectType: 'user',
        subjectId: user.id,
        actorType: 'human',
        actorId: user.personId,
        actorLabel: active.roleSlug,
      },
    });
  });

  const token = signToken({
    userId: user.id,
    tenantId: user.tenantId,
    affiliationId: active.id,
    stepUp: false,
  });

  return { token, user: await buildSessionUser(user.id, user.tenantId, active.id, false) };
}

/** `GET /auth/entities` — the same list `login()` would have offered, for a principal already holding a normal token. */
export async function entitiesForToken(payload: TokenPayload): Promise<EntityOption[]> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: payload.userId } });
  if (!user.principalId) throw ApiError.unauthorized('This account has no principal — sign-in cannot resolve its entities. Contact whoever created the account.');
  return entitiesFor(user.principalId);
}

/**
 * Identifies whoever is calling `/auth/switch-entity`, from either a normal
 * bearer token or the short-lived selection token `login()` issued — the two
 * are told apart by shape (`purpose: 'select-entity'` versus `userId`), not by
 * which header carried them, so one route handles both.
 */
export async function identifySwitchCaller(token: string): Promise<{ principalId: string; sourceTenantId?: string; sourceUserId?: string }> {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    throw ApiError.unauthorized('Session token is invalid or expired.');
  }
  const payload = decoded as Partial<SelectionTokenPayload & TokenPayload>;

  if (payload.purpose === 'select-entity' && payload.principalId) {
    return { principalId: payload.principalId };
  }
  if (payload.userId && payload.tenantId) {
    const user = await unscopedPrisma.user.findFirst({ where: { id: payload.userId, status: 'active' } });
    if (!user?.principalId) throw ApiError.unauthorized('This account has no principal.');
    return { principalId: user.principalId, sourceTenantId: payload.tenantId, sourceUserId: payload.userId };
  }
  throw ApiError.unauthorized('Not a recognised session token.');
}

/**
 * `POST /auth/switch-entity` — the entity-picker's other half. Accepts either
 * a normal bearer token (a principal already inside one entity, switching to
 * another) or the short-lived selection token `login()` issued. A tenant the
 * principal holds no active affiliation in is a 404, never a 403 — the same
 * posture the tenant gate itself takes for a cross-tenant reach.
 */
export async function switchEntity(
  caller: { principalId: string; sourceTenantId?: string; sourceUserId?: string },
  targetTenantId: string,
) {
  const target = await unscopedPrisma.user.findFirst({
    where: { principalId: caller.principalId, tenantId: targetTenantId, status: 'active', tenant: { status: 'active' } },
  });
  if (!target) throw ApiError.notFound('Entity');

  const affiliations = await unscopedPrisma.affiliation.findMany({
    where: { tenantId: target.tenantId, partyId: target.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });
  if (affiliations.length === 0) throw ApiError.notFound('Entity');

  const active = affiliations.find((a) => a.id === target.activeAffiliationId) ?? affiliations.find((a) => a.primaryFlag) ?? affiliations[0];

  await unscopedPrisma.user.update({
    where: { id: target.id },
    data: { lastLoginAt: new Date(), activeAffiliationId: active.id },
  });

  await asSystem(target.tenantId, async () => {
    await prisma.auditRecord.create({
      data: {
        tenantId: target.tenantId,
        action: 'login',
        subjectType: 'user',
        subjectId: target.id,
        actorType: 'human',
        actorId: target.personId,
        actorLabel: active.roleSlug,
        diff: { via: 'switch-entity' },
      },
    });
    await emit({
      name: EVENTS.ENTITY_SWITCHED,
      subject: { entityType: 'user', entityId: target.id },
      newState: { fromTenantId: caller.sourceTenantId ?? null, toTenantId: target.tenantId },
    });
  });

  // A caller who arrived with a normal token (not merely the selection token)
  // is leaving a tenant, and that side gets its own record — the register of
  // who was in a given tenant's data does not have a gap for the seconds
  // spent in another one.
  if (caller.sourceTenantId && caller.sourceUserId && caller.sourceTenantId !== target.tenantId) {
    await asSystem(caller.sourceTenantId, async () => {
      await prisma.auditRecord.create({
        data: {
          tenantId: caller.sourceTenantId!,
          action: 'switch_entity',
          subjectType: 'user',
          subjectId: caller.sourceUserId!,
          actorType: 'human',
          actorId: target.personId,
          diff: { via: 'switch-entity', toTenantId: target.tenantId },
        },
      });
    });
  }

  const token = signToken({ userId: target.id, tenantId: target.tenantId, affiliationId: active.id, stepUp: false });
  return { token, user: await buildSessionUser(target.id, target.tenantId, active.id, false) };
}

export async function buildSessionUser(
  userId: string,
  tenantId: string,
  affiliationId: string,
  stepUp: boolean,
): Promise<SessionUser> {
  const user = await unscopedPrisma.user.findFirstOrThrow({
    where: { id: userId },
    include: { tenant: true, person: true },
  });

  const affiliations = await unscopedPrisma.affiliation.findMany({
    where: { tenantId, partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });

  const active = affiliations.find((a) => a.id === affiliationId) ?? affiliations[0];
  const roleSlug = active?.roleSlug ?? 'sales';

  const role = await unscopedPrisma.accessRole.findFirst({ where: { tenantId, slug: roleSlug } });
  const ceiling = (role?.classificationCeiling ?? ROLE_CLASSIFICATION_CEILING[roleSlug] ?? 'internal') as SensitivityClass;

  const auth = toAuthContext({ userId, tenantId, affiliationId: active.id, stepUp }, user.personId, roleSlug, user.branch, active.orgUnitId, ceiling);

  const [grants, authorityGrants, entityCount] = await Promise.all([
    runWithContext(newRequestContext({ auth }), () => resolveGrants(auth)),
    unscopedPrisma.authorityGrant.findMany({ where: { tenantId, principalId: user.personId, status: 'active' } }),
    user.principalId ? countEntities(user.principalId) : Promise.resolve(1),
  ]);

  const affiliationSummaries: AffiliationSummary[] = affiliations.map((a) => ({
    id: a.id,
    affiliationType: a.affiliationType,
    counterpartyName: a.counterpartyName,
    roleSlug: a.roleSlug ?? 'sales',
    primaryFlag: a.primaryFlag,
    status: a.status,
    effectiveFrom: a.effectiveFrom.toISOString(),
    effectiveTo: a.effectiveTo?.toISOString() ?? null,
    requiresStepUp: STEP_UP_ROLES.has(a.roleSlug ?? ''),
  }));

  return {
    userId: user.id,
    principalId: user.principalId ?? '',
    personId: user.personId,
    fullName: user.person.fullName,
    email: user.email,
    tenantId,
    tenantName: user.tenant.name,
    tenantKind: user.tenant.kind as SessionUser['tenantKind'],
    parentTenantId: user.tenant.parentTenantId,
    entityCount,
    activeAffiliationId: active.id,
    roleSlug,
    archetype: (role?.archetype ?? 'workspace') as SurfaceArchetype,
    classificationCeiling: ceiling,
    affiliations: affiliationSummaries,
    grants: grants.map((g) => formatGrant({ resource: g.resource, verbs: g.verbs, scope: g.scope })),
    authorityGrants: authorityGrants.map((g) => ({
      authorityClass: g.authorityClass,
      ceilingValue: num(g.ceilingValue),
      currency: g.currency,
      countCeiling: g.countCeiling,
      countWindow: g.countWindow,
      riskClassCeiling: g.riskClassCeiling,
    })),
    branch: user.branch,
  };
}

export function toAuthContext(
  payload: TokenPayload,
  partyId: string,
  roleSlug: string,
  branch: string | null,
  orgUnitId: string | null,
  ceiling: SensitivityClass,
): AuthContext {
  return {
    tenantId: payload.tenantId,
    principalType: 'human',
    partyId,
    userId: payload.userId,
    agentId: null,
    onBehalfOfPartyId: null,
    affiliationId: payload.affiliationId,
    roleSlug,
    branch,
    orgUnitId,
    classificationCeiling: ceiling,
    // Regulated data always requires an explicit purpose binding; an ordinary
    // session carries the operational purpose.
    purpose: 'operational',
    consentCodes: [],
    stepUpVerified: payload.stepUp,
  };
}

/**
 * Reach never unions across contexts. Switching re-composes the screen against
 * the new affiliation's grants alone.
 */
export async function switchContext(userId: string, tenantId: string, affiliationId: string, stepUpProvided: boolean) {
  const affiliation = await unscopedPrisma.affiliation.findFirst({ where: { id: affiliationId, tenantId } });
  if (!affiliation) throw ApiError.notFound('Affiliation');

  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: userId } });
  if (affiliation.partyId !== user.personId) {
    throw ApiError.forbidden('That affiliation is not held by this person.');
  }
  if (affiliation.status !== 'active') {
    throw ApiError.forbidden('That affiliation is no longer active.');
  }

  const requiresStepUp = STEP_UP_ROLES.has(affiliation.roleSlug ?? '');
  if (requiresStepUp && !stepUpProvided) {
    throw ApiError.forbidden(
      `Switching into the ${affiliation.roleSlug} context requires step-up re-authentication.`,
      [{ axis: 'WHO', passed: false, reason: 'step_up_required' }],
    );
  }

  // Mutates the existing session; no new session is issued.
  await unscopedPrisma.user.update({ where: { id: userId }, data: { activeAffiliationId: affiliationId } });

  await asSystem(tenantId, async () => {
    await emit({
      name: EVENTS.SESSION_CONTEXT_SWITCHED,
      subject: { entityType: 'user', entityId: userId },
      newState: { affiliationId, roleSlug: affiliation.roleSlug },
    });
  });

  const token = signToken({ userId, tenantId, affiliationId, stepUp: stepUpProvided });
  return { token, user: await buildSessionUser(userId, tenantId, affiliationId, stepUpProvided) };
}
