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

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  ROLE_CLASSIFICATION_CEILING,
  EVENTS,
  type AffiliationSummary,
  type SessionUser,
  type SurfaceArchetype,
  type SensitivityClass,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../platform/db.js';
import { asSystem, runWithContext, newRequestContext, type AuthContext } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { resolveGrants } from '../platform/permissions.js';
import { formatGrant } from '@kaizen/shared';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL = '12h';

/** Privileged contexts require step-up re-auth to commit a switch. */
const STEP_UP_ROLES = new Set(['chairman', 'director', 'finance_controller', 'system_admin', 'founder', 'admin']);

export interface TokenPayload {
  userId: string;
  tenantId: string;
  affiliationId: string;
  stepUp: boolean;
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

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function login(email: string, password: string, tenantSlug?: string) {
  // Login runs before a tenant is resolved, so it uses the unscoped client
  // deliberately and narrowly — the only place that is legitimate.
  const user = await unscopedPrisma.user.findFirst({
    where: {
      email: email.toLowerCase(),
      status: 'active',
      ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
    },
    include: { tenant: true, person: true },
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw ApiError.unauthorized('Email or password is incorrect.');
  }

  const affiliations = await unscopedPrisma.affiliation.findMany({
    where: { tenantId: user.tenantId, partyId: user.personId, status: 'active' },
    orderBy: [{ primaryFlag: 'desc' }, { createdAt: 'asc' }],
  });

  if (affiliations.length === 0) {
    throw ApiError.forbidden('This account holds no active affiliation. Access derives from affiliations, never from the person record.');
  }

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

  const [grants, authorityGrants] = await Promise.all([
    runWithContext(newRequestContext({ auth }), () => resolveGrants(auth)),
    unscopedPrisma.authorityGrant.findMany({ where: { tenantId, principalId: user.personId, status: 'active' } }),
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
    personId: user.personId,
    fullName: user.person.fullName,
    email: user.email,
    tenantId,
    tenantName: user.tenant.name,
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
