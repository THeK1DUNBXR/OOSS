import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

const ownerUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public';

/**
 * The concurrency suite (CI-GATES-DRAFT section 2; ORDERED-PLAN Wave 7). Its own
 * config so that the serial suite stays serial by construction (vitest.config.ts)
 * and the races are run on their own, with their own timeouts.
 *
 * The env is the serial suite's, copied rather than imported: the two configs
 * must agree on the database roles, and a shared module would let one change
 * reach the serial suite unreviewed.
 *
 * Files do not run in parallel here, though each test inside a file fires its
 * work at once. Every file in this directory asserts tenant-wide state (the
 * event hash chain, the receipt series, the trial balance) against the same
 * tenant, so a second file writing at the same time would be part of what the
 * first one is checking.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/concurrency/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      // The owner runs migrations, seeds and the unscoped jobs (BYPASSRLS).
      // Requests and the scoped client connect as the application role, which
      // row-level security binds, so the races run under the same restriction
      // production does (FX-51). Provisioned by scripts/test-db.sh.
      MIGRATION_DATABASE_URL: ownerUrl,
      UNSCOPED_DATABASE_URL: ownerUrl,
      DATABASE_URL:
        process.env.TEST_APP_DATABASE_URL ?? ownerUrl.replace('//kaizen:kaizen@', '//kaizen_app:kaizen_app@'),
      NODE_ENV: 'test',
      DOCUMENT_STORAGE_DIR: process.env.TEST_DOCUMENT_STORAGE_DIR ?? join(tmpdir(), 'kaizen-test-documents'),
      JWT_SECRET: 'test-only-secret-not-used-anywhere-else-0123456789',
      JOBS_ENABLED: 'false',
    },
  },
});
