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
  validatePassword,
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
import { generateTotpSecret, otpauthUri, verifyTotp } from '../domains/compliance/corporate/totp.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const TOKEN_TTL = '12h';
const MFA_CHALLENGE_TTL = '5m';

/**
 * Known placeholder values that must never reach a real deploy — one lifted
 * straight from this file's own former default, one from `.env.example`, one
 * from `docker-compose.yml`.
 */
const FALLBACK_JWT_SECRETS = new Set([
  'dev-secret-change-me',
  'change-me-in-production',
  'docker-development-secret-not-for-production',
]);

/**
 * CMP-COR-001: the API refuses to start with `JWT_SECRET` unset or equal to a
 * known fallback value. `NODE_ENV=test`/`development` is the one exception —
 * logged loudly rather than silently tolerated, because "it works on my
 * machine" is exactly how a fallback secret reaches production.
 *
 * Exported so a test can call it directly with a constructed `env`, rather
 * than only indirectly through process exit.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const secret = env.JWT_SECRET;
  const insecure = !secret || FALLBACK_JWT_SECRETS.has(secret);
  if (!insecure) return;

  const reason = !secret ? 'JWT_SECRET is not set.' : `JWT_SECRET is set to a known placeholder value.`;
  const nodeEnv = env.NODE_ENV;

  if (nodeEnv === 'test' || nodeEnv === 'development') {
    console.warn(
      `[security] ${reason} Continuing because NODE_ENV=${nodeEnv}. This must never be true when NODE_ENV=production.`,
    );
    return;
  }

  throw new Error(
    `${reason} Refusing to start outside test/development. Set a real JWT_SECRET (NODE_ENV is currently ${nodeEnv ?? 'unset'}).`,
  );
}

// Not called at module load: this file is imported by one-off scripts (the
// fixture seeder, `npm run jobs:run`) that have no reason to set NODE_ENV,
// and those must keep working. `server.ts` calls this explicitly, once,
// right before it opens a socket — that is the actual point "the API
// starts" means, and where CMP-COR-001 is enforced.

/** Privileged contexts require step-up re-auth to commit a switch. */
const STEP_UP_ROLES = new Set(['chairman', 'finance_head', 'hr_ops_manager']);

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

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

export interface MfaChallengePayload {
  userId: string;
  tenantId: string;
  affiliationId: string;
  mfaChallenge: true;
}

function signMfaChallenge(payload: Omit<MfaChallengePayload, 'mfaChallenge'>): string {
  return jwt.sign({ ...payload, mfaChallenge: true }, JWT_SECRET, { expiresIn: MFA_CHALLENGE_TTL });
}

function verifyMfaChallenge(token: string): MfaChallengePayload {
  let payload: unknown;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    throw ApiError.unauthorized('MFA challenge is invalid or expired. Sign in again.');
  }
  const p = payload as Partial<MfaChallengePayload>;
  if (!p.mfaChallenge || !p.userId || !p.tenantId || !p.affiliationId) {
    throw ApiError.unauthorized('MFA challenge is invalid or expired. Sign in again.');
  }
  return p as MfaChallengePayload;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/**
 * The password-policy floor (CMP-COR-001 supporting rule): at least twelve
 * characters, never the account's own email, never on the small blocklist.
 * Called wherever a password is set or reset — `changePassword` here, and any
 * future admin-reset endpoint — never left to the caller to remember.
 */
export function assertPasswordAllowed(password: string, email?: string | null): void {
  const check = validatePassword(password, email);
  if (!check.valid) {
    throw ApiError.unprocessable(`Password does not meet the policy: ${check.reasons.join(' ')}`);
  }
}

/** Finishes a login: audits it, resets the failure counters, issues the real token. */
async function completeLogin(
  user: { id: string; tenantId: string; personId: string },
  active: { id: string; roleSlug: string | null },
  stepUp: boolean,
) {
  await unscopedPrisma.user.update({
    where: { id: user.id },
    data: {
      lastLoginAt: new Date(),
      activeAffiliationId: active.id,
      failedLoginCount: 0,
      lockedUntil: null,
    },
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

  const token = signToken({ userId: user.id, tenantId: user.tenantId, affiliationId: active.id, stepUp });
  return { token, user: await buildSessionUser(user.id, user.tenantId, active.id, stepUp) };
}

export interface LoginResult {
  token: string;
  user: SessionUser;
}

export interface MfaRequiredResult {
  mfaRequired: true;
  challengeToken: string;
}

/**
 * Account lockout (CMP-COR-001 supporting rule): five wrong passwords lock
 * the account for fifteen minutes, reset on the next success. A locked
 * account gets the same wording whether the lock is fresh or was already in
 * force — the count itself is not exposed, so a caller cannot use it to
 * enumerate how close an account is to locking.
 */
export async function login(email: string, password: string, tenantSlug?: string): Promise<LoginResult | MfaRequiredResult> {
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

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.unauthorized(
      `This account is locked after repeated failed sign-ins. Try again after ${user.lockedUntil.toISOString()}.`,
    );
  }

  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordOk) {
    if (user) {
      const failedLoginCount = user.failedLoginCount + 1;
      const lockOut = failedLoginCount >= MAX_FAILED_LOGINS;
      await unscopedPrisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lockOut ? 0 : failedLoginCount,
          lockedUntil: lockOut ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil,
        },
      });
    }
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

  // MFA: a user who has enrolled a second factor never gets a working session
  // from a password alone. The challenge token carries no authority of its
  // own — `verifyMfaChallenge` is the only thing that accepts it, and only at
  // `/auth/mfa/verify`.
  if (user.mfaEnabledAt) {
    return { mfaRequired: true, challengeToken: signMfaChallenge({ userId: user.id, tenantId: user.tenantId, affiliationId: active.id }) };
  }

  return completeLogin(user, active, false);
}

/** Completes a login begun with `login()` once the second factor checks out. */
export async function verifyMfaAndLogin(challengeToken: string, code: string): Promise<LoginResult> {
  const payload = verifyMfaChallenge(challengeToken);
  const user = await unscopedPrisma.user.findFirst({ where: { id: payload.userId, status: 'active' } });
  if (!user || !user.mfaSecret) throw ApiError.unauthorized('MFA challenge is invalid or expired. Sign in again.');

  if (!verifyTotp(user.mfaSecret, code)) {
    throw ApiError.unauthorized('That code is not correct. Codes are valid for about thirty seconds — check the app is still showing a current one.');
  }

  const affiliation = await unscopedPrisma.affiliation.findFirst({
    where: { id: payload.affiliationId, tenantId: payload.tenantId, status: 'active' },
  });
  if (!affiliation) throw ApiError.forbidden('That affiliation is no longer active.');

  // A completed MFA challenge is the platform's step-up mechanism for this
  // session: `stepUp: true` is what a gated approve action checks for.
  return completeLogin(user, affiliation, true);
}

/**
 * Enrolment, in two steps: request a secret (returned once — the server
 * keeps only the secret, never the plaintext response), then confirm a code
 * generated from it before `mfaEnabledAt` is set. Enrolling does not itself
 * require MFA — it is how a user gets one.
 */
export async function enrolMfa(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
  const secret = generateTotpSecret();
  await unscopedPrisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });
  return { secret, otpauthUri: otpauthUri(secret, email) };
}

export async function confirmMfa(userId: string, code: string): Promise<void> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: userId } });
  if (!user.mfaSecret) {
    throw ApiError.unprocessable('No MFA enrolment is in progress. Call /auth/mfa/enrol first.');
  }
  if (!verifyTotp(user.mfaSecret, code)) {
    throw ApiError.unprocessable('That code did not match. Scan the QR code again and try the current one.');
  }
  await unscopedPrisma.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } });
}

/**
 * Self-service password change. Validated against the policy floor and
 * re-hashed; `passwordChangedAt` is stamped so a "when did this last change"
 * question never depends on the audit log alone.
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw ApiError.unauthorized('Current password is incorrect.');
  }
  assertPasswordAllowed(newPassword, user.email);
  await unscopedPrisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
  });
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
