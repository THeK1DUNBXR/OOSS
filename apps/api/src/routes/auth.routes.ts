import { Router } from 'express';
import { z } from 'zod';
import { buildSessionUser, changePassword, confirmMfa, enrolMfa, login, switchContext, verifyMfaAndLogin } from '../lib/auth.js';
import { onboardingState } from '../domains/onboarding.js';
import { handler, requireAuth } from '../lib/http.js';
import { ApiError } from '../platform/errors.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { navigationFor, surfaceCompositionFor } from '../domains/surfaces.js';
import { loginRateLimit } from '../domains/compliance/corporate/rateLimit.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().optional(),
});

router.post(
  '/login',
  loginRateLimit,
  handler(async (req) => {
    const input = loginSchema.parse(req.body);
    return login(input.email, input.password, input.tenantSlug);
  }),
);

/** Step two of a login for a user with `mfaEnabledAt` set — see `lib/auth.ts`. */
router.post(
  '/mfa/verify',
  handler(async (req) => {
    const schema = z.object({ challengeToken: z.string(), code: z.string() });
    const input = schema.parse(req.body);
    return verifyMfaAndLogin(input.challengeToken, input.code);
  }),
);

/** Requests a fresh TOTP secret. Returned once — the server keeps the secret, not this response. */
router.post(
  '/mfa/enrol',
  requireAuth,
  handler(async (req) => {
    const auth = req.ctx!.auth!;
    const user = await prisma.user.findFirstOrThrow({ where: { id: auth.userId! } });
    return enrolMfa(auth.userId!, user.email);
  }),
);

/** Confirms enrolment with a code generated from the secret `mfa/enrol` returned. */
router.post(
  '/mfa/confirm',
  requireAuth,
  handler(async (req) => {
    const schema = z.object({ code: z.string() });
    const input = schema.parse(req.body);
    const auth = req.ctx!.auth!;
    await confirmMfa(auth.userId!, input.code);
    return { ok: true };
  }),
);

router.post(
  '/change-password',
  requireAuth,
  handler(async (req) => {
    const schema = z.object({ currentPassword: z.string(), newPassword: z.string() });
    const input = schema.parse(req.body);
    const auth = req.ctx!.auth!;
    await changePassword(auth.userId!, input.currentPassword, input.newPassword);
    return { ok: true };
  }),
);

router.get(
  '/me',
  requireAuth,
  handler(async (req) => {
    const auth = req.ctx!.auth!;
    return buildSessionUser(auth.userId!, auth.tenantId, auth.affiliationId!, auth.stepUpVerified);
  }),
);

/** The context switcher. Privileged contexts require step-up re-auth. */
router.post(
  '/switch-context',
  requireAuth,
  handler(async (req) => {
    const schema = z.object({ affiliationId: z.string(), stepUpPassword: z.string().optional() });
    const input = schema.parse(req.body);
    const auth = req.ctx!.auth!;

    let stepUpProvided = false;
    if (input.stepUpPassword) {
      // Re-verify the credential rather than trusting a client assertion.
      const { default: bcrypt } = await import('bcryptjs');
      const user = await prisma.user.findFirst({ where: { id: auth.userId! } });
      if (!user) throw ApiError.notFound('User');
      stepUpProvided = await bcrypt.compare(input.stepUpPassword, user.passwordHash);
      if (!stepUpProvided) throw ApiError.unauthorized('Step-up verification failed.');
    }

    return switchContext(auth.userId!, auth.tenantId, input.affiliationId, stepUpProvided);
  }),
);

/** Nav is a projection of the module map, filtered per grant. Unreachable nodes are unrendered, never disabled. */
router.get(
  '/navigation',
  requireAuth,
  handler(async () => navigationFor()),
);

/**
 * The persisted composition, so "why wasn't X on his screen on 14 March" is
 * answerable without re-derivation.
 */
router.get(
  '/composition/:templateKey',
  requireAuth,
  handler(async (req) => surfaceCompositionFor(req.params.templateKey)),
);

router.get(
  '/notifications',
  requireAuth,
  handler(async () => {
    const auth = currentAuth();
    const rows = await prisma.notification.findMany({
      where: { tenantId: auth.tenantId, recipientPartyId: auth.partyId ?? '' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((n) => ({
      id: n.id,
      priority: n.priority,
      title: n.title,
      body: n.body,
      channel: n.channel,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
      drillPath: n.drillPath,
      severity: n.severity,
    }));
  }),
);

router.post(
  '/notifications/:id/read',
  requireAuth,
  handler(async (req) => {
    const auth = currentAuth();
    await prisma.notification.updateMany({
      where: { id: req.params.id, recipientPartyId: auth.partyId ?? '' },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }),
);

/**
 * The setup checklist, computed from what actually exists rather than from
 * anything the user has ticked.
 */
router.get('/onboarding', requireAuth, handler(async () => onboardingState()));

export default router;
