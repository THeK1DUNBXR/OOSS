import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { extname, join, sep } from 'node:path';
import routes from './routes/index.js';
import { contextMiddleware, errorMiddleware } from './lib/http.js';
import { captureWebhookRawBody } from './lib/webhookSignature.js';
import { requestLog } from './lib/requestLog.js';
import { startScheduler } from './jobs/scheduler.js';
import { registerSubscribers } from './events/handlers.js';
import { prisma } from './platform/db.js';
import { config } from './platform/config.js';
import { logger } from './platform/logger.js';
import { PostgresRateLimitStore } from './platform/rateLimitStore.js';
import { BUILD, STARTED_AT, buildLabel } from './platform/build.js';
import { reconcileNavForAllTenants } from './platform/navSync.js';
import { addMissingGrantsForAllTenants } from './platform/grantSync.js';
import { reconcileTenantKinds } from './platform/tenantKind.js';
import { reconcileMarketingDefaultsForAllTenants } from './platform/marketingSync.js';
import { reconcileApprovalGatePoliciesForAllTenants } from './platform/approvalPolicySync.js';
import { assertProductionSecrets } from './lib/auth.js';

/** `CORS_ORIGINS` is comma-separated; an empty entry is a typo, not an origin. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The Content-Security-Policy for the built client. `'self'` covers the hashed
 * bundles Vite emits; index.html carries no inline script. Google Fonts is the
 * one outside origin the client loads (index.html). No `'unsafe-inline'` for
 * scripts: an injected inline handler is exactly what this header exists to stop.
 */
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  // Caddy terminates TLS. Upgrading http subresources here would break a local
  // http run of this process, and gains nothing behind Caddy.
  upgradeInsecureRequests: null,
};

export function createApp({
  webDistDir = config.WEB_DIST_DIR,
  corsOrigins = parseCorsOrigins(config.CORS_ORIGINS),
}: { webDistDir?: string; corsOrigins?: string[] } = {}) {
  const app = express();

  // Caddy is the only thing that reaches this process, over loopback. Without
  // this every request's req.ip is 127.0.0.1 and the per-IP rate limits in
  // marketing/capture.ts and compliance/corporate/rateLimit.ts count the whole
  // internet as one client.
  app.set('trust proxy', 'loopback');

  // HSTS is deliberately not set here: Caddy sends it on every response
  // (deploy/Caddyfile), and two copies that disagree about max-age are worse
  // than one.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      strictTransportSecurity: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // An origin not on the list gets no Access-Control-Allow-Origin, so the
  // browser refuses to hand its response to that page. A request with no Origin
  // header is same-origin or not a browser at all, and needs no CORS answer.
  const allowed = new Set(corsOrigins);
  app.use(
    cors({
      origin: (origin, done) => done(null, origin !== undefined && allowed.has(origin) ? origin : false),
    }),
  );
  // The webhook route verifies an HMAC over the exact bytes sent, so it needs the
  // raw body. `verify` runs alongside the normal parse and leaves it unchanged.
  app.use(express.json({ limit: '2mb', verify: captureWebhookRawBody }));
  app.use(contextMiddleware);
  app.use(requestLog());

  // A per-address ceiling on the whole API. It is generous on purpose: an
  // office behind one NAT address shares it. The tight limit is login's, in
  // compliance/corporate/rateLimit.ts; this one only stops a runaway client or
  // a scraper from taking the process down.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 6000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      store: new PostgresRateLimitStore('api'),
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' } },
    }),
  );

  // The build is on /health as well as behind the login, so "did my deploy land"
  // is one curl rather than a sign-in. Nothing tenant-specific is here: the seed
  // stamp is somebody's data and lives behind `/api/meta/version`.
  app.get('/health', async (req, res) => {
    const build = { version: BUILD.version, sequence: BUILD.sequence, commit: BUILD.commit, startedAt: STARTED_AT };
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', service: 'kaizen-api', time: new Date().toISOString(), build });
    } catch (err) {
      // This route has no auth, and a driver error text names the database
      // host and user. The text goes to the log; the probe gets the status.
      logger.error({ requestId: req.ctx?.requestId, err }, 'health check failed: database unreachable');
      res.status(503).json({ status: 'degraded', build });
    }
  });

  app.use('/api', routes);

  if (webDistDir) serveClient(app, webDistDir);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } });
  });

  app.use(errorMiddleware);
  return app;
}

/**
 * The built client, served from the same origin as the API.
 *
 * Hashed files under /assets are named by content, so a URL never changes
 * meaning and can be cached forever. index.html is the one file that names
 * them, so it must never be cached — a cached shell points at chunks a later
 * deploy deleted, and the user sees a blank page until a hard reload.
 *
 * Client routes fall back to index.html. A path with a file extension, or
 * anything under /assets, is not a client route: if it is missing it stays a
 * 404 so a stale tab fails visibly instead of executing HTML as JavaScript.
 */
function serveClient(app: express.Express, webDistDir: string): void {
  app.use(
    express.static(webDistDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(`${sep}index.html`)) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${sep}assets${sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  const indexHtml = join(webDistDir, 'index.html');
  app.get(/^(?!\/(api|health)(\/|$)).*$/, (req, res, next) => {
    if (req.path.startsWith('/assets/') || extname(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
}

const port = config.PORT;

if (config.NODE_ENV !== 'test') {
  // CMP-COR-001, stated again explicitly right before the process actually
  // starts serving traffic — `lib/auth.ts` already checks this at module
  // load, which covers every import path; this is the last chance before a
  // socket opens.
  assertProductionSecrets();


  const app = createApp();
  // Cross-domain subscribers register once at boot, against canonical names only.
  registerSubscribers();

  // The sidebar is code. Reconciling it here means a deploy is enough to make
  // the menu match what shipped — a new screen appears, a renamed one is
  // renamed, a retired one goes — without anybody remembering to run the seed.
  // Two releases in a row shipped screens that could not be reached because
  // that step was manual and nobody knew it existed.
  //
  // Failure is logged and swallowed: a menu one deploy stale is bad, an API
  // that will not start is worse.
  void reconcileNavForAllTenants()
    .then(({ tenants, written, retired }) => {
      logger.info(
        { component: 'boot' },
        `Navigation reconciled: ${written} entries across ${tenants} tenant(s)` +
          (retired > 0 ? `, ${retired} retired` : ''),
      );
    })
    .catch((error: unknown) => {
      logger.error({ component: 'boot', err: error }, 'Navigation could not be reconciled at boot');
    });

  // And the other half of the same problem: a release that adds a whole new
  // resource leaves every existing tenant with no grant row for it, so nobody
  // can use the screen that shipped with it. Only resources a role has never
  // had a row for are filled in — changing or revoking an existing grant stays
  // a deliberate act through `reconcileGrants --apply`.
  void addMissingGrantsForAllTenants()
    .then(({ tenants, added }) => {
      if (added.length > 0) {
        logger.info({ component: 'boot' }, `Grants: ${added.length} new resource(s) granted across ${tenants} tenant(s)`);
      }
    })
    .catch((error: unknown) => {
      logger.error({ component: 'boot', err: error }, 'Grants could not be brought up to the matrix at boot');
    });

  // Never trust `kind` as written — a subsidiary added since the last boot
  // must flip its parent to `holding` without anybody running the seed by
  // hand.
  void reconcileTenantKinds()
    .then((changes) => {
      if (changes.length > 0) {
        logger.info({ component: 'boot' }, `Tenant kinds reconciled: ${changes.map((c) => `${c.slug} -> ${c.to}`).join(', ')}`);
      }
    })
    .catch((error: unknown) => {
      logger.error({ component: 'boot', err: error }, 'Tenant kinds could not be reconciled at boot');
    });

  // Marketing's own per-tenant defaults (channels, starter score rules) —
  // same idempotent every-boot reconcile shape as nav and grants above.
  void reconcileMarketingDefaultsForAllTenants()
    .then(({ tenants, channelsCreated, scoreRulesCreated }) => {
      if (channelsCreated > 0 || scoreRulesCreated > 0) {
        logger.info(
          { component: 'boot' },
          `Marketing defaults reconciled across ${tenants} tenant(s): ${channelsCreated} channel(s), ${scoreRulesCreated} score rule(s) created`,
        );
      }
    })
    .catch((error: unknown) => {
      logger.error({ component: 'boot', err: error }, 'Marketing defaults could not be reconciled at boot');
    });

  // Approval ladders the seed will not rewrite (it skips an existing v1). A
  // tenant seeded before FX-01 routes IT-policy publishes to a finance_head who
  // cannot decide them until this publishes the chairman-only version.
  void reconcileApprovalGatePoliciesForAllTenants()
    .then(({ tenants, published, failed }) => {
      if (published > 0 || failed > 0) {
        logger.info(
          { component: 'boot' },
          `Approval ladders reconciled across ${tenants} tenant(s): ${published} new version(s), ${failed} failed`,
        );
      }
    })
    .catch((error: unknown) => {
      logger.error({ component: 'boot', err: error }, 'Approval ladders could not be reconciled at boot');
    });

  app.listen(port, () => {
    // Says which build, so a log line answers "what is running" too.
    logger.info({ component: 'boot' }, `Kaizen API listening on :${port} — build ${buildLabel()}`);
    startScheduler();
  });
}
