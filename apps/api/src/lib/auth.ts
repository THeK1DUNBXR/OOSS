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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  type EntityOption,
  type TenantConfig,
  type TenantKind,
} from '@kaizen/shared';
import { prisma, unscopedPrisma, num } from '../platform/db.js';
import { asSystem, runWithContext, newRequestContext, type AuthContext } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { resolveGrants } from '../platform/permissions.js';
import { config } from '../platform/config.js';
import { formatGrant } from '@kaizen/shared';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../domains/compliance/corporate/totp.js';
import { auditWrite, createChainedAuditRecord } from '../platform/audit.js';

const JWT_SECRET = config.JWT_SECRET;
/**
 * The access token is short because it is the only thing a stolen copy can
 * use, and the Session row is what makes even this window closeable: logout
 * and reuse detection take effect on the next request, not on expiry.
 */
const TOKEN_TTL = '15m';
/**
 * Lifetime of a whole session, measured from sign-in. Rotation does not extend
 * it: a session that keeps refreshing still ends thirty days after the login
 * that started it, so a forgotten browser cannot stay signed in indefinitely.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MFA_CHALLENGE_TTL = '5m';
const SELECTION_TOKEN_TTL = '5m';

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
  /** Names the Session row this access token belongs to. Tokens without one are refused. */
  jti: string;
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

/** SHA-256 hex of a refresh secret. See the Session model for why this is not `hashPassword`. */
export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The Session behind an access token, or null when the token must not be
 * honoured: no `jti` (issued before sessions existed), no row, revoked, past
 * its lifetime, or not the user and tenant the token was minted for.
 */
export async function liveSessionFor(payload: TokenPayload) {
  if (!payload.jti) return null;
  const session = await unscopedPrisma.session.findUnique({ where: { jti: payload.jti } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  if (session.userId !== payload.userId || session.tenantId !== payload.tenantId) return null;
  return session;
}

/**
 * Audit and event writes made before a request context exists (login, refresh)
 * run as the signed-in human, not as the system, so the record names who
 * actually acted. `auditWrite` and `emit` both read the context they are given.
 */
function actingAs(tenantId: string, partyId: string | null, roleSlug: string | null) {
  return newRequestContext({
    auth: {
      tenantId,
      principalType: 'human',
      partyId,
      userId: null,
      agentId: null,
      onBehalfOfPartyId: null,
      affiliationId: null,
      roleSlug,
      branch: null,
      orgUnitId: null,
      classificationCeiling: 'internal',
      purpose: 'operational',
      consentCodes: [],
      stepUpVerified: false,
    },
  });
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
      // An affiliation with no role contributes no role here, rather than a
      // default one (see http.ts, where the same fallback was removed).
      roleSlugs: [...new Set(affiliations.flatMap((a) => (a.roleSlug ? [a.roleSlug] : [])))],
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

/**
 * Finishes a login: opens the Session, audits and emits it, resets the failure
 * counters, and issues the access token and the first refresh secret.
 */
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

  const refreshSecret = randomBytes(32).toString('base64url');
  const jti = randomUUID();
  const session = await unscopedPrisma.session.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      jti,
      refreshTokenHash: hashRefreshSecret(refreshSecret),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  await runWithContext(actingAs(user.tenantId, user.personId, active.roleSlug), async () => {
    await auditWrite({ action: 'login', subjectType: 'session', subjectId: session.id, meta: { userId: user.id } });
    await emit({
      name: EVENTS.SESSION_ISSUED,
      subject: { entityType: 'session', entityId: session.id },
      newState: { userId: user.id, affiliationId: active.id },
    });
  });

  const token = signToken({ userId: user.id, tenantId: user.tenantId, affiliationId: active.id, stepUp, jti });
  return {
    token,
    refreshToken: `${session.id}.${refreshSecret}`,
    user: await buildSessionUser(user.id, user.tenantId, active.id, stepUp),
  };
}

export interface LoginResult {
  token: string;
  /** `<sessionId>.<secret>`. Rotates on every refresh; the old one is then reuse. */
  refreshToken: string;
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
 *
 * The credential lives on the `Principal` (one email, one password, however
 * many entities); the lock and the second factor live on each per-tenant
 * `User`, because a lock is a fact about an account someone is attacking and
 * MFA is enrolled per entity. A wrong password therefore counts against every
 * user the principal holds, and a lock on any of them refuses the sign-in.
 *
 * Order: lock → password → entity selection → MFA → session. A principal
 * holding affiliations in several entities gets the entity list and a
 * selection token instead of a session; `switchEntity` finishes it, and runs
 * the same MFA gate for the chosen entity.
 */
export async function login(
  email: string,
  password: string,
  tenantSlug?: string,
): Promise<LoginResult | MfaRequiredResult | EntitySelectionResult> {
  // Login runs before a tenant is resolved, so it uses the unscoped client
  // deliberately and narrowly — the only place that is legitimate.
  const lower = email.toLowerCase();
  let principal = await unscopedPrisma.principal.findFirst({ where: { email: lower, status: 'active' } });

  // A `User` still carrying the deprecated `passwordHash` (created before the
  // principal existed, or by a fixture that writes the hash directly) is
  // walked onto a principal here, at its first sign-in, rather than refused
  // until someone re-runs the seed. The hash is copied, never re-derived.
  if (!principal) {
    const unmigrated = await unscopedPrisma.user.findFirst({
      where: { email: lower, principalId: null, passwordHash: { not: null }, status: 'active' },
    });
    if (unmigrated?.passwordHash) {
      principal = await unscopedPrisma.principal.create({ data: { email: lower, passwordHash: unmigrated.passwordHash } });
      await unscopedPrisma.user.updateMany({
        where: { email: lower, principalId: null },
        data: { principalId: principal.id, passwordHash: null },
      });
    }
  }

  const users = principal
    ? await unscopedPrisma.user.findMany({
        where: {
          principalId: principal.id,
          status: 'active',
          tenant: { status: 'active' },
          ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
        },
        include: { tenant: true, person: true },
      })
    : [];

  const now = new Date();
  const locked = users.find((u) => u.lockedUntil && u.lockedUntil > now);
  if (locked?.lockedUntil) {
    throw ApiError.unauthorized(
      `This account is locked after repeated failed sign-ins. Try again after ${locked.lockedUntil.toISOString()}.`,
    );
  }

  const passwordOk = principal ? await bcrypt.compare(password, principal.passwordHash) : false;
  if (!principal || !passwordOk) {
    for (const user of users) {
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

  // At least one active affiliation, in the tenant(s) considered.
  const candidates: typeof users = [];
  for (const user of users) {
    const affiliations = await unscopedPrisma.affiliation.findMany({
      where: { tenantId: user.tenantId, partyId: user.personId, status: 'active' },
    });
    if (affiliations.length > 0) candidates.push(user);
  }

  if (candidates.length === 0) {
    throw ApiError.forbidden('This account holds no active affiliation. Access derives from affiliations, never from the person record.');
  }

  await unscopedPrisma.principal.update({ where: { id: principal.id }, data: { lastLoginAt: new Date() } });

  if (candidates.length > 1) {
    return {
      entities: await entitiesFor(principal.id, email),
      selectionToken: signSelectionToken(principal.id),
    };
  }

  return issueSessionFor(candidates[0], false);
}

/**
 * The last step every sign-in path shares — the single-entity login, the
 * entity picker and the in-session switch: pick the affiliation, run the MFA
 * gate, and only then issue a session.
 */
async function issueSessionFor(
  user: { id: string; tenantId: string; personId: string; activeAffiliationId: string | null; mfaEnabledAt: Date | null },
  stepUp: boolean,
): Promise<LoginResult | MfaRequiredResult> {
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

  return completeLogin(user, active, stepUp);
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
  if (!user.principalId) throw ApiError.unauthorized('This account has no principal.');
  const principal = await unscopedPrisma.principal.findFirstOrThrow({ where: { id: user.principalId } });
  if (!(await bcrypt.compare(currentPassword, principal.passwordHash))) {
    throw ApiError.unauthorized('Current password is incorrect.');
  }
  assertPasswordAllowed(newPassword, principal.email);
  await unscopedPrisma.principal.update({
    where: { id: principal.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  // The credential is one thing across entities, so the "last changed" stamp
  // lands on every user of the principal, not only the one that asked.
  await unscopedPrisma.user.updateMany({ where: { principalId: principal.id }, data: { passwordChangedAt: new Date() } });
}

/** `GET /auth/entities` — the same list `login()` would have offered, for a principal already holding a normal token. */
export async function entitiesForToken(payload: Omit<TokenPayload, 'jti'>): Promise<EntityOption[]> {
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
export async function identifySwitchCaller(
  token: string,
): Promise<{ principalId: string; sourceTenantId?: string; sourceUserId?: string; sourceSessionId?: string }> {
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
    // A revoked session cannot be used to reach another entity either.
    const session = await liveSessionFor(payload as TokenPayload);
    if (!session) throw ApiError.unauthorized('Session token is invalid or expired.');
    const user = await unscopedPrisma.user.findFirst({ where: { id: payload.userId, status: 'active' } });
    if (!user?.principalId) throw ApiError.unauthorized('This account has no principal.');
    return {
      principalId: user.principalId,
      sourceTenantId: payload.tenantId,
      sourceUserId: payload.userId,
      sourceSessionId: session.id,
    };
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
  caller: { principalId: string; sourceTenantId?: string; sourceUserId?: string; sourceSessionId?: string },
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

  // A caller who arrived with a normal token (not merely the selection token)
  // is leaving a tenant, and that side gets its own record — the register of
  // who was in a given tenant's data does not have a gap for the seconds
  // spent in another one.
  if (caller.sourceTenantId && caller.sourceUserId && caller.sourceTenantId !== target.tenantId) {
    await asSystem(caller.sourceTenantId, async () => {
      await createChainedAuditRecord({
        tenantId: caller.sourceTenantId!,
        action: 'switch_entity',
        subjectType: 'user',
        subjectId: caller.sourceUserId!,
        actorType: 'human',
        actorId: target.personId,
        diff: { via: 'switch-entity', toTenantId: target.tenantId },
      });
    });
  }

  const issued = await issueSessionFor(target, false);
  if ('mfaRequired' in issued) return issued;

  // The session the caller arrived on is replaced by the one just opened, so a
  // principal does not keep two live sessions from one sign-in. Only a caller
  // holding a session token has one; the selection-token path does not.
  if (caller.sourceSessionId) {
    await unscopedPrisma.session.updateMany({
      where: { id: caller.sourceSessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await asSystem(target.tenantId, async () => {
    await emit({
      name: EVENTS.ENTITY_SWITCHED,
      subject: { entityType: 'user', entityId: target.id },
      newState: { fromTenantId: caller.sourceTenantId ?? null, toTenantId: target.tenantId },
    });
  });
  return issued;
}

/**
 * `POST /auth/refresh`. Rotates the refresh secret and issues a new access
 * token under a new jti, which the Session row now records as the live one.
 *
 * Presenting the secret rotated away from is reuse: either the browser was
 * copied, or the legitimate holder is replaying a stale copy. The two cannot
 * be told apart, so the whole session is revoked and the event audited, and
 * the caller signs in again. There is no grace window; a rotated secret is
 * dead the moment it is replaced.
 */
export async function refreshSession(refreshToken: string): Promise<LoginResult> {
  const refused = () => ApiError.unauthorized('This session has ended. Sign in again.');
  const dot = refreshToken.indexOf('.');
  if (dot <= 0 || dot === refreshToken.length - 1) throw refused();
  const sessionId = refreshToken.slice(0, dot);
  const presented = hashRefreshSecret(refreshToken.slice(dot + 1));

  const session = await unscopedPrisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw refused();

  const user = await unscopedPrisma.user.findFirst({ where: { id: session.userId, status: 'active' } });
  if (!user) throw refused();

  if (presented === session.refreshTokenHash) {
    const active = user.activeAffiliationId
      ? await unscopedPrisma.affiliation.findFirst({ where: { id: user.activeAffiliationId, tenantId: user.tenantId, status: 'active' } })
      : null;
    if (!active) throw refused();

    const nextSecret = randomBytes(32).toString('base64url');
    const jti = randomUUID();
    // Conditional on the hash still being current, so two requests racing with
    // the same secret cannot both rotate it: the loser falls through to reuse.
    const rotated = await unscopedPrisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: hashRefreshSecret(nextSecret), previousRefreshTokenHash: session.refreshTokenHash, jti },
    });
    if (rotated.count === 1) {
      const token = signToken({ userId: user.id, tenantId: user.tenantId, affiliationId: active.id, stepUp: false, jti });
      return {
        token,
        refreshToken: `${session.id}.${nextSecret}`,
        user: await buildSessionUser(user.id, user.tenantId, active.id, false),
      };
    }
    throw await refuseReuse(session.id, user.tenantId, user.personId, active.roleSlug);
  }

  if (session.previousRefreshTokenHash && presented === session.previousRefreshTokenHash) {
    throw await refuseReuse(session.id, user.tenantId, user.personId, null);
  }

  // A secret this session never issued: refused, and the session is left alone,
  // because whoever sent it has learned nothing about the session.
  throw refused();
}

/** Revokes the session on a reused refresh secret, audits and emits it, and returns the error to throw. */
async function refuseReuse(sessionId: string, tenantId: string, personId: string, roleSlug: string | null) {
  const revoked = await unscopedPrisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 1) {
    await runWithContext(actingAs(tenantId, personId, roleSlug), async () => {
      await auditWrite({ action: 'refresh_reuse', subjectType: 'session', subjectId: sessionId });
      await emit({ name: EVENTS.SESSION_REFRESH_REUSED, subject: { entityType: 'session', entityId: sessionId } });
    });
  }
  return ApiError.unauthorized('This session has ended. Sign in again.');
}

/**
 * `POST /auth/logout`. Revokes the caller's own session, so the access token
 * still within its fifteen minutes stops working on its next request.
 *
 * No `assertCan`: the session is the caller's own, and the bearer token that
 * reached this point is the authority for ending it. Refusing a sign-out on a
 * grant would leave a user unable to close a session they are holding.
 */
export async function logoutSession(sessionId: string): Promise<void> {
  const revoked = await unscopedPrisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count !== 1) return;
  await auditWrite({ action: 'logout', subjectType: 'session', subjectId: sessionId });
  await emit({ name: EVENTS.SESSION_REVOKED, subject: { entityType: 'session', entityId: sessionId } });
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
  // No role is no role: see http.ts. The session carries null and no grants.
  const roleSlug = active?.roleSlug ?? null;

  const role = roleSlug ? await unscopedPrisma.accessRole.findFirst({ where: { tenantId, slug: roleSlug } }) : null;
  const ceiling = (
    roleSlug ? (role?.classificationCeiling ?? ROLE_CLASSIFICATION_CEILING[roleSlug] ?? 'internal') : 'public'
  ) as SensitivityClass;

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
    roleSlug: a.roleSlug,
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
  payload: Omit<TokenPayload, 'jti'>,
  partyId: string,
  roleSlug: string | null,
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
export async function switchContext(
  userId: string,
  tenantId: string,
  affiliationId: string,
  stepUpProvided: boolean,
  sessionId: string,
) {
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

  // Mutates the existing session; no new session is issued. The access token
  // is re-keyed to a fresh jti, so the Session row is told which token is live.
  const jti = randomUUID();
  await unscopedPrisma.user.update({ where: { id: userId }, data: { activeAffiliationId: affiliationId } });
  await unscopedPrisma.session.update({ where: { id: sessionId }, data: { jti } });

  await asSystem(tenantId, async () => {
    await emit({
      name: EVENTS.SESSION_CONTEXT_SWITCHED,
      subject: { entityType: 'user', entityId: userId },
      newState: { affiliationId, roleSlug: affiliation.roleSlug },
    });
  });

  const token = signToken({ userId, tenantId, affiliationId, stepUp: stepUpProvided, jti });
  return { token, user: await buildSessionUser(userId, tenantId, affiliationId, stepUpProvided) };
}
