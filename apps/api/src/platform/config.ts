/**
 * The environment, parsed once, or the process does not start.
 *
 * Every `process.env` read used to happen wherever it was needed, with a `??`
 * default beside it. That is fine until the default is a secret. `JWT_SECRET`
 * fell back to the string `dev-secret-change-me`, committed and public, so a
 * deploy that forgot one variable did not fail — it came up and cheerfully
 * accepted tokens anybody could forge, for any user, in any tenant. A missing
 * variable has to be a dead process, not a quiet downgrade.
 *
 * So: one schema, parsed at module load, before anything else can read the
 * environment. Required variables have no default and no fallback. The process
 * refuses to start and says which variable is wrong and why.
 *
 * `parseEnv` is exported separately from the parsing that happens on import so
 * a test can assert the refusals without taking the test runner down with it.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `.env` is loaded here rather than incidentally.
 *
 * Nothing in this repository imported `dotenv`; the file was being read as a
 * side effect of Prisma's own loader, which meant whether a variable was
 * visible depended on whether `platform/db.ts` happened to be imported first.
 * That is not a property to leave to import order in the module that decides
 * whether the process may run at all.
 */
function loadDotEnv(): void {
  for (const candidate of [resolve(here, '../../.env'), resolve(here, '../../../../.env')]) {
    try {
      // Node 20.12+. Values already in the real environment win, which is what
      // a container needs — the file is a developer convenience, not an override.
      process.loadEnvFile(candidate);
      return;
    } catch {
      /* absent or unreadable: the real environment is expected to carry it */
    }
  }
}

/** `'true'`/`'1'`/`'yes'` and their negatives, because shells only have strings. */
const booleanish = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes', 'on'].includes(v)));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      errorMap: () => ({ message: "must be one of 'development', 'test' or 'production'" }),
    }),

    /**
     * The application role. Row-level security binds it, and the boot check
     * (rlsGuard.ts) refuses a role with rolsuper or rolbypassrls.
     */
    DATABASE_URL: z.string().min(1, 'must be a Postgres connection string'),

    /**
     * The migration owner, used by `prisma migrate` (schema.prisma `directUrl`).
     * It owns the tables and so must not be the role the API serves requests as.
     */
    MIGRATION_DATABASE_URL: z.string().min(1).optional(),

    /**
     * The role behind `unscopedPrisma`: seed, cross-tenant jobs and the audit
     * hash chain. It needs BYPASSRLS. Unset, those paths run as the application
     * role and see no tenant rows (db.ts).
     */
    UNSCOPED_DATABASE_URL: z.string().min(1).optional(),

    /**
     * 32 characters is not arbitrary: HS256 keys shorter than the hash output
     * give an attacker a cheaper brute force than the algorithm implies, and a
     * short one is almost always a human-chosen word.
     */
    JWT_SECRET: z.string().min(32, 'must be at least 32 characters — generate one, do not invent it'),

    /**
     * Keys AES-256-GCM encryption of PAN, Aadhaar and bank values (privacy.ts).
     * Required in production because the only other option is a constant that
     * is printed in this repository: encryption under it protects nothing from
     * anyone who has read the source. Outside production the development key is
     * allowed, with a warning, so a laptop does not need a secret to boot.
     */
    FIELD_ENCRYPTION_KEY: z
      .string()
      .min(32, 'must be at least 32 characters — generate one, do not invent it')
      .optional(),

    /**
     * Signs the public unsubscribe links. Optional because JWT_SECRET is a
     * working fallback; a separate secret means rotating one does not
     * invalidate the other's links.
     */
    MARKETING_UNSUBSCRIBE_SECRET: z
      .string()
      .min(32, 'must be at least 32 characters — generate one, do not invent it')
      .optional(),

    PORT: z.coerce.number().int().positive().default(4000),

    /**
     * Built client (apps/web/dist). When set, the API serves it so the whole app
     * is one origin behind Caddy — see deploy/Caddyfile. Unset in development,
     * where Vite serves the client.
     */
    WEB_DIST_DIR: z.string().min(1).optional(),

    /**
     * Where document bytes are kept (objectStorage.ts). A local directory until
     * hosting is chosen: the provider, and whether it sits in an India region for
     * tenants that require one, is a hosting decision made after Phase 1
     * (DECISIONS D:599-615). Unset, the store refuses uploads rather than
     * writing to a default place.
     */
    DOCUMENT_STORAGE_DIR: z.string().min(1).optional(),

    /**
     * Where the browser client is served from. Read by the CORS allowlist; a
     * comma-separated list so one deployment can serve a staging and a preview
     * origin without a code change.
     */
    CORS_ORIGINS: z.string().optional(),

    JOBS_ENABLED: booleanish(false),
    /** Boot fills in grant rows for resources a tenant has never had. See grantSync.ts. */
    GRANT_AUTOSYNC: booleanish(true),

    PRISMA_LOG: z.enum(['query']).optional(),

    /** Stamped by the build so a running process can say what it is. See build.ts. */
    BUILD_SEQUENCE: z.coerce.number().int().nonnegative().optional(),
    GIT_SHA: z.string().optional(),
    BUILT_AT: z.string().optional(),

    /** Seed-time identity of the tenant being provisioned. */
    TENANT_SLUG: z.string().default('kaizen'),
    TENANT_NAME: z.string().default('Kaizen Infinities'),
    SEED_EMAIL_DOMAIN: z.string().default('kaizen.co.in'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.FIELD_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIELD_ENCRYPTION_KEY'],
        message: 'is required when NODE_ENV is production — it keys encryption of PAN, Aadhaar and bank values',
      });
    }
    // Without a role that bypasses RLS, the cross-tenant jobs (outbox drain, audit
    // chain, scheduler) and the seed see no rows and do not say so. Production
    // refuses to start rather than run them that way.
    if (env.NODE_ENV === 'production' && !env.UNSCOPED_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['UNSCOPED_DATABASE_URL'],
        message:
          'is required when NODE_ENV is production — the jobs and the audit chain read across tenants and need a role with BYPASSRLS',
      });
    }
  });

export type Config = Readonly<z.infer<typeof envSchema>>;

/** Thrown with a message a person can act on without reading this file. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      [
        'The environment is not usable, so the process will not start.',
        ...issues.map((i) => `  - ${i}`),
        '',
        'Set these in apps/api/.env for local work, or in the deployment environment.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/**
 * Pure: takes an environment, returns a config or throws. Exported so the
 * refusals can be tested without a subprocess.
 */
export function parseEnv(raw: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const name = i.path.join('.') || '(root)';
      // A missing variable and a malformed one are different problems and the
      // message says which, because "invalid" sends somebody looking for a typo
      // in a variable they never set.
      const missing = i.code === 'invalid_type' && 'received' in i && i.received === 'undefined';
      return missing ? `${name} is not set` : `${name} ${i.message}`;
    });
    throw new ConfigError(issues);
  }
  return Object.freeze(result.data);
}

function load(): Config {
  loadDotEnv();
  try {
    return parseEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Not `logger.error`: this runs before anything is wired up, and a
      // stack trace here would bury the one line that matters.
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export const config: Config = load();
