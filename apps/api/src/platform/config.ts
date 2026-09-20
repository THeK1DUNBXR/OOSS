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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    errorMap: () => ({ message: "must be one of 'development', 'test' or 'production'" }),
  }),

  DATABASE_URL: z.string().min(1, 'must be a Postgres connection string'),

  /**
   * 32 characters is not arbitrary: HS256 keys shorter than the hash output
   * give an attacker a cheaper brute force than the algorithm implies, and a
   * short one is almost always a human-chosen word.
   */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters — generate one, do not invent it'),

  PORT: z.coerce.number().int().positive().default(4000),

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
